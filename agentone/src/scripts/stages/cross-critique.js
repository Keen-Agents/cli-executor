import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runAgent } from '../lib/agent-runner.js';
import { CostTracker } from '../lib/cost-tracker.js';
import { assembleContext } from '../lib/context-assembler.js';
import { TIMEOUTS, DEFAULTS } from '../pipeline-config.js';

const STAGE_NAME = 'cross-critique';
const COMPLETED_REGEX = /<COMPLETED>([\s\S]*?)<\/COMPLETED>/;
const CONVERGED_SIGNAL = '<CONVERGED>';
const DEBATE_SAFETY_CAP = DEFAULTS.debateSafetyCap ?? 10;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CRITIQUE_PROMPT_TEMPLATE_PATH = resolve(__dirname, '../prompts/critique.md');
const ADVERSARIAL_PROMPT_TEMPLATE_PATH = resolve(__dirname, '../prompts/critique-adversarial.md');

const CONVERGENCE_PHRASES = [
  /no significant (?:remaining )?issues/i,
  /plan is solid/i,
  /no major (?:changes|issues|concerns) (?:needed|remaining|found)/i,
  /plan adequately addresses/i,
  /no critical (?:issues|problems|flaws)/i,
  /well[- ]structured (?:and |plan )/i,
  /ready for implementation/i,
];
const CHANGE_RATIO_THRESHOLD = 0.10;
const MAX_PLAN_CHARS = 12000;
const MAX_CONTEXT_CHARS = 4000;
const MAX_CRITIQUE_CHARS = 6000;
const MAX_PRIOR_CRITIQUES = 50;
const MAX_PRIOR_BLOCK_CHARS = 30000;

function asText(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function trimToChars(text, maxChars) {
  const normalized = asText(text);
  if (maxChars <= 0 || normalized.length <= maxChars) {
    return normalized;
  }
  return normalized.slice(0, Math.max(0, maxChars - 20)).trimEnd() + '\n...[truncated]';
}

function fillTemplate(template, replacements) {
  let output = template;
  for (const [key, value] of Object.entries(replacements)) {
    output = output.split(key).join(asText(value));
  }
  return output;
}

function normalizePlanLines(text) {
  return text
    .toLowerCase()
    .replace(/[#*_`~>|]/g, '')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function computeChangeRatio(planA, planB) {
  const linesA = normalizePlanLines(planA);
  const linesB = normalizePlanLines(planB);
  if (linesA.length === 0 && linesB.length === 0) return 0;

  const setA = new Set(linesA);
  const setB = new Set(linesB);
  let changed = 0;
  for (const line of setB) {
    if (!setA.has(line)) changed += 1;
  }
  for (const line of setA) {
    if (!setB.has(line)) changed += 1;
  }
  const total = Math.max(linesA.length, linesB.length);
  return total === 0 ? 0 : changed / total;
}

function detectCritiqueConvergence(critiqueText) {
  for (const pattern of CONVERGENCE_PHRASES) {
    if (pattern.test(critiqueText)) {
      return true;
    }
  }
  return false;
}

function buildSynthesisPrompt({ ticket, rounds, initialPlan }) {
  const parts = [
    'You are a senior architect producing the FINAL implementation plan.',
    'A debate between a planner and a critic ran for multiple rounds. Each round the planner revised the plan and the critic found new issues.',
    'The debate did NOT converge — the revisions kept oscillating, fixing some issues while re-introducing others.',
    '',
    'Your job: read ALL revisions and ALL critiques, then produce ONE definitive plan that:',
    '1. Takes the BEST resolution for each critique point across ALL rounds',
    '2. Does NOT regress on any issue that was properly solved in ANY round',
    '3. Does NOT include speculative fixes that no critique actually asked for',
    '4. Resolves contradictions between rounds by picking the technically stronger answer',
    '',
    `Ticket: ${asText(ticket?.key)}`,
    `Summary: ${asText(ticket?.summary)}`,
    '',
    '=== INITIAL PLAN (before debate) ===',
    initialPlan,
    '',
  ];

  for (const r of rounds) {
    parts.push(`=== ROUND ${r.round} CRITIQUE (${r.critiqueIssueCount || '?'} issues, changeRatio: ${r.changeRatio || '?'}) ===`);
    parts.push(r.critique);
    parts.push('');
    if (r.revisedPlan) {
      parts.push(`=== ROUND ${r.round} REVISION ===`);
      parts.push(r.revisedPlan);
      parts.push('');
    }
  }

  parts.push(
    '',
    'Now produce the final consolidated plan. Take the best from every round. Do not leave any properly-solved critique unaddressed.',
    '',
    'Return the final plan wrapped in tags:',
    '<COMPLETED>',
    '[Final consolidated plan]',
    '</COMPLETED>'
  );

  return parts.join('\n');
}

function buildRevisionPrompt({ ticket, currentPlan, critique, round, maxRounds, isAutoMode, priorCritiques }) {
  const roundLabel = isAutoMode ? `${round} (auto mode — no fixed limit)` : `${round} of ${maxRounds}`;
  const parts = [
    'You are the original planner revising an implementation plan based on critique.',
    '',
    `Ticket: ${asText(ticket?.key)}`,
    `Summary: ${asText(ticket?.summary)}`,
    `Revision Round: ${roundLabel}`,
    '',
    'Current Plan:',
    currentPlan,
    '',
  ];

  if (priorCritiques && priorCritiques.length > 0) {
    parts.push('Prior Round Critiques (already addressed):');
    for (const prior of priorCritiques) {
      parts.push(`--- Round ${prior.round} ---`);
      parts.push(prior.text);
      parts.push('');
    }
  }

  parts.push(
    'Latest Critique To Address:',
    critique,
    '',
    'Revise the plan to address the latest critique while keeping it practical and complete.',
    'CRITICAL: You have the FULL critique history above. Do NOT re-introduce issues that prior rounds already solved.',
    'Before changing any section, check if a prior critique raised and resolved the same point — keep the existing fix.',
    'If the latest critique contradicts a prior resolution, pick the technically stronger answer and explain why.',
    'If the critique is already addressed in the current plan, keep the plan unchanged and state that briefly.',
    '',
    'Return only the revised plan wrapped in tags:',
    '<COMPLETED>',
    '[Revised plan]',
    '</COMPLETED>'
  );

  return parts.join('\n');
}

function resolveProfile(state) {
  const classify = state.getStageOutput('classify');
  const fromArtifact = typeof classify?.profile === 'string' ? classify.profile.trim() : '';
  if (fromArtifact) {
    return { profile: fromArtifact };
  }

  const fromState = typeof state?.toJSON?.()?.profile === 'string' ? state.toJSON().profile.trim() : '';
  if (fromState) {
    return { profile: fromState, forced: true };
  }

  return null;
}

export async function run(context) {
  context.state.stageStart(STAGE_NAME);
  context.logger?.log({ type: 'STAGE_STARTED', stage: STAGE_NAME });

  try {
    const planOutput = context.state.getStageOutput('dual-plan')
                    || context.state.getStageOutput('plan');
    if (!planOutput || typeof planOutput !== 'object') {
      throw new Error('Cross-critique stage requires plan output from stage "plan" or "dual-plan".');
    }

    const intakeOutput = context.state.getStageOutput('intake');
    if (!intakeOutput || typeof intakeOutput !== 'object') {
      throw new Error('Cross-critique stage requires intake output from stage "intake".');
    }

    const classifyOutput = resolveProfile(context.state);
    if (!classifyOutput || typeof classifyOutput !== 'object') {
      throw new Error('Cross-critique stage requires a resolved profile from state or stage "classify".');
    }

    const adversarial = Boolean(context?.config?.adversarialCritique);
    const rawRounds = context?.config?.maxConvergenceRounds ?? DEFAULTS.maxConvergenceRounds ?? 'auto';
    const isAutoMode = rawRounds === 'auto' || rawRounds === -1;
    const baseMaxRounds = isAutoMode ? DEBATE_SAFETY_CAP : Number(rawRounds);
    const maxRounds = adversarial ? Math.max(baseMaxRounds, 4) : baseMaxRounds;
    const changeRatioThreshold = adversarial ? 0.05 : CHANGE_RATIO_THRESHOLD;
    const initialPlan = asText(planOutput.plan).trim();
    if (!initialPlan) {
      throw new Error('Cross-critique stage requires non-empty plan.plan text from stage "plan".');
    }

    if (maxRounds === 0) {
      const skippedOutput = {
        rounds: [],
        finalPlan: initialPlan,
        totalRounds: 0,
        converged: true,
        note: 'Skipped: maxConvergenceRounds is 0.'
      };
      context.state.checkpoint(STAGE_NAME, skippedOutput);
      context.logger?.log({ type: 'STAGE_COMPLETED', stage: STAGE_NAME, skipped: true });
      return skippedOutput;
    }

    const templatePath = adversarial ? ADVERSARIAL_PROMPT_TEMPLATE_PATH : CRITIQUE_PROMPT_TEMPLATE_PATH;
    const critiqueTemplate = readFileSync(templatePath, 'utf8');

    context.logger?.log({
      type: 'GATE_CHECK',
      stage: STAGE_NAME,
      gate: 'critique_start',
      mode: isAutoMode ? 'auto' : 'fixed',
      adversarial,
      maxRounds,
      safetyCap: isAutoMode ? DEBATE_SAFETY_CAP : undefined,
      changeRatioThreshold
    });

    // ── Resume support: check for completed round checkpoints ──
    const rounds = [];
    const priorCritiques = [];
    let currentPlan = initialPlan;
    let converged = false;
    let convergenceReason = null;

    for (let r = 1; r <= maxRounds; r++) {
      const roundCheckpoint = context.state.getStageOutput(`cross-critique-round-${r}`);
      if (roundCheckpoint) {
        rounds.push(roundCheckpoint);
        priorCritiques.push({ round: r, text: roundCheckpoint.critique });
        if (roundCheckpoint.revisedPlan) {
          currentPlan = roundCheckpoint.revisedPlan;
        }
        if (roundCheckpoint.converged) {
          converged = true;
          convergenceReason = roundCheckpoint.convergenceReason || 'resumed';
        }
      } else {
        break;
      }
    }

    if (rounds.length > 0 && !converged) {
      context.logger?.log({
        type: 'GATE_CHECK',
        stage: STAGE_NAME,
        gate: 'partial_resume',
        completedRounds: rounds.length
      });
    }

    for (let round = rounds.length + 1; round <= maxRounds && !converged; round += 1) {
      if (context.signal?.aborted) break;

      const recentPriorCritiques = priorCritiques
        .slice(-MAX_PRIOR_CRITIQUES)
        .map(p => ({ ...p, text: trimToChars(p.text, MAX_CRITIQUE_CHARS) }));

      const priorCritiqueBlock = recentPriorCritiques.length > 0
        ? trimToChars(
            recentPriorCritiques.map(p => `### Round ${p.round} Critique\n${p.text}`).join('\n\n'),
            MAX_PRIOR_BLOCK_CHARS
          )
        : '';

      let critiquePrompt = fillTemplate(critiqueTemplate, {
        '{{TICKET_KEY}}': asText(intakeOutput.key),
        '{{TICKET_SUMMARY}}': asText(intakeOutput.summary),
        '{{PLAN}}': trimToChars(currentPlan, MAX_PLAN_CHARS),
        '{{ROUND}}': String(round),
        '{{MAX_ROUNDS}}': isAutoMode ? 'unlimited (auto)' : String(maxRounds),
        '{{PRIOR_CRITIQUE}}': priorCritiqueBlock
      });

      // In auto mode, append convergence instructions to the prompt
      if (isAutoMode) {
        critiquePrompt += `\n\n## Convergence Rule (AUTO MODE)\n\n` +
          `This critique loop has NO fixed number of rounds. You keep critiquing until the plan is genuinely solid.\n` +
          `There is no pressure to converge early — take as many rounds as needed.\n\n` +
          `When you are GENUINELY satisfied that the plan has no remaining substantive issues, include ${CONVERGED_SIGNAL} ` +
          `at the start of your response followed by a brief explanation of why convergence is appropriate.\n\n` +
          `Do NOT converge just because several rounds have passed. Only converge when:\n` +
          `- All prior critique points have been adequately addressed\n` +
          `- No new substantive issues remain\n` +
          `- The plan is implementable as-is\n\n` +
          `If ANY real issues remain, keep critiquing. Do NOT agree politely.`;
      }

      const contextBlock = assembleContext(context.state, 'cross-critique', MAX_CONTEXT_CHARS, { otherPlan: currentPlan, priorCritique: priorCritiqueBlock });
      if (contextBlock) {
        critiquePrompt += '\n\n## Additional Context\n' + trimToChars(contextBlock, MAX_CONTEXT_CHARS);
      }

      const humanRevision = context.state.getLatestHumanRevision?.();
      if (humanRevision?.comments) {
        critiquePrompt += `\n\n## Human Revision Request\n${humanRevision.comments}`;
      }

      const critiqueResult = await runAgent({
        cli: 'codex',
        prompt: critiquePrompt,
        cwd: context.workDir || undefined,
        timeout: TIMEOUTS['cross-critique'],
        label: `cross-critique-critique-r${round}-${asText(intakeOutput.key) || 'unknown'}`,
        metadata: {
          stage: STAGE_NAME,
          mode: 'critique',
          round,
          maxRounds,
          ticketKey: intakeOutput.key,
          profile: classifyOutput.profile,
          runId: context.state.runId
        },
        extractRegex: COMPLETED_REGEX,
        signal: context.signal
      });

      if (context.costTracker) {
        context.costTracker.recordCall(STAGE_NAME, CostTracker.fromAgentResult(critiqueResult));
      }

      if (critiqueResult.timedOut) {
        throw new Error(`Cross-critique round ${round} critique timed out after ${critiqueResult.durationMs}ms.`);
      }

      if (!critiqueResult.content) {
        throw new Error(`Cross-critique round ${round} critique did not include a <COMPLETED> tag.`);
      }

      const critiqueText = critiqueResult.content.trim();

      // Check convergence: explicit <CONVERGED> signal OR phrase detection
      const hasConvergedSignal = critiqueText.includes(CONVERGED_SIGNAL);
      const critiqueSignalsConverged = hasConvergedSignal || detectCritiqueConvergence(critiqueText);

      let revisedPlan = '';
      let revisionSessionId = null;
      let revisionDurationMs = null;
      let changeRatio = null;

      if (critiqueSignalsConverged) {
        // Critic says no significant issues — skip revision, converge
        converged = true;
        convergenceReason = hasConvergedSignal ? 'converged_signal' : 'critique_approved';
        context.logger?.log({
          type: 'GATE_CHECK',
          stage: STAGE_NAME,
          gate: 'convergence',
          round,
          method: convergenceReason,
          message: hasConvergedSignal
            ? 'Critic declared <CONVERGED>; plan accepted.'
            : 'Critic indicated plan is solid; skipping revision.'
        });
      } else {
        // Critic has issues — run revision
        const revisionPrompt = buildRevisionPrompt({
          ticket: intakeOutput,
          currentPlan: trimToChars(currentPlan, MAX_PLAN_CHARS),
          critique: trimToChars(critiqueText, MAX_CRITIQUE_CHARS),
          round,
          maxRounds,
          isAutoMode,
          priorCritiques: recentPriorCritiques
        });

        const revisionResult = await runAgent({
          cli: 'claude',
          prompt: revisionPrompt,
          cwd: context.workDir || undefined,
          timeout: TIMEOUTS['cross-critique'],
          label: `cross-critique-revision-r${round}-${asText(intakeOutput.key) || 'unknown'}`,
          metadata: {
            stage: STAGE_NAME,
            mode: 'revision',
            round,
            maxRounds,
            ticketKey: intakeOutput.key,
            profile: classifyOutput.profile,
            runId: context.state.runId
          },
          extraArgs: ['--allowedTools', 'WebSearch,WebFetch,Task'],
          extractRegex: COMPLETED_REGEX,
          signal: context.signal
        });

        if (context.costTracker) {
          context.costTracker.recordCall(STAGE_NAME, CostTracker.fromAgentResult(revisionResult));
        }

        if (revisionResult.timedOut) {
          throw new Error(`Cross-critique round ${round} revision timed out after ${revisionResult.durationMs}ms.`);
        }

        if (!revisionResult.content) {
          throw new Error(`Cross-critique round ${round} revision did not include a <COMPLETED> tag.`);
        }

        revisedPlan = revisionResult.content.trim();
        revisionSessionId = revisionResult.sessionId || null;
        revisionDurationMs = revisionResult.durationMs;

        // Check diff-based convergence
        changeRatio = computeChangeRatio(currentPlan, revisedPlan);
        if (changeRatio <= changeRatioThreshold) {
          converged = true;
          convergenceReason = 'low_change_ratio';
        }

        context.logger?.log({
          type: 'GATE_CHECK',
          stage: STAGE_NAME,
          gate: 'convergence',
          round,
          changeRatio: Math.round(changeRatio * 1000) / 1000,
          threshold: changeRatioThreshold,
          converged
        });

        currentPlan = revisedPlan || currentPlan;
      }

      priorCritiques.push({ round, text: critiqueText });

      // Count numbered issues in critique (e.g. "1.", "2.", etc.)
      const critiqueIssueCount = (critiqueText.match(/^\s*\d+\.\s/gm) || []).length;

      const roundData = {
        round,
        critique: critiqueText,
        revisedPlan,
        critiqueSessionId: critiqueResult.sessionId || '',
        revisionSessionId,
        critiqueDurationMs: critiqueResult.durationMs,
        revisionDurationMs,
        critiqueSignalsConverged,
        critiqueIssueCount,
        changeRatio,
        converged,
        convergenceReason: converged ? convergenceReason : null
      };
      rounds.push(roundData);

      // Checkpoint each round for resume support
      context.state.checkpoint(`cross-critique-round-${round}`, roundData);

      if (converged) {
        context.logger?.log({
          type: 'GATE_CHECK',
          stage: STAGE_NAME,
          gate: isAutoMode ? 'auto_converged' : 'converged',
          round,
          method: convergenceReason
        });
        break;
      }

      // Budget check between rounds
      const budgetStatus = context.costTracker?.checkBudget?.();
      if (budgetStatus && budgetStatus.status === 'exceeded') {
        context.logger?.log({
          type: 'GATE_CHECK',
          stage: STAGE_NAME,
          gate: 'budget',
          round,
          spent: budgetStatus.spent,
          message: 'Budget exceeded during cross-critique; stopping early.'
        });
        break;
      }
    }

    if (!converged && rounds.length >= maxRounds) {
      context.logger?.log({
        type: 'GATE_CHECK',
        stage: STAGE_NAME,
        gate: isAutoMode ? 'safety_cap_reached' : 'max_rounds_reached',
        totalRounds: rounds.length,
        safetyCap: isAutoMode ? DEBATE_SAFETY_CAP : undefined
      });
    }

    // ── Synthesis step: consolidate best of all rounds into final plan ──
    let synthesizedPlan = null;
    if (rounds.length >= 2 && !context.signal?.aborted) {
      context.logger?.log({
        type: 'GATE_CHECK',
        stage: STAGE_NAME,
        gate: 'synthesis_start',
        totalRounds: rounds.length,
        converged,
        message: converged
          ? 'Running synthesis to consolidate converged debate.'
          : 'Debate did not converge — synthesizing best of all rounds.'
      });

      const synthesisPrompt = buildSynthesisPrompt({
        ticket: intakeOutput,
        rounds,
        initialPlan
      });

      const synthesisResult = await runAgent({
        cli: 'claude',
        prompt: synthesisPrompt,
        cwd: context.workDir || undefined,
        timeout: TIMEOUTS['cross-critique'],
        label: `cross-critique-synthesis-${asText(intakeOutput.key) || 'unknown'}`,
        metadata: {
          stage: STAGE_NAME,
          mode: 'synthesis',
          totalRounds: rounds.length,
          converged,
          ticketKey: intakeOutput.key,
          runId: context.state.runId
        },
        extraArgs: ['--allowedTools', 'WebSearch,WebFetch,Task'],
        extractRegex: COMPLETED_REGEX,
        signal: context.signal
      });

      if (context.costTracker) {
        context.costTracker.recordCall(STAGE_NAME, CostTracker.fromAgentResult(synthesisResult));
      }

      if (synthesisResult.content) {
        synthesizedPlan = synthesisResult.content.trim();
        context.logger?.log({
          type: 'GATE_CHECK',
          stage: STAGE_NAME,
          gate: 'synthesis_complete',
          synthesizedPlanLength: synthesizedPlan.length,
          message: 'Synthesis agent produced consolidated plan.'
        });
        context.state.checkpoint('cross-critique-synthesis', {
          synthesizedPlan,
          sessionId: synthesisResult.sessionId || null,
          durationMs: synthesisResult.durationMs
        });
      } else {
        context.logger?.log({
          type: 'GATE_CHECK',
          stage: STAGE_NAME,
          gate: 'synthesis_failed',
          message: 'Synthesis agent did not produce output; falling back to last revision.'
        });
      }
    }

    const finalPlan = synthesizedPlan || currentPlan;

    const output = {
      rounds,
      finalPlan,
      synthesizedPlan: synthesizedPlan || null,
      hasSynthesis: !!synthesizedPlan,
      totalRounds: rounds.length,
      converged,
      convergenceReason
    };

    context.state.checkpoint(STAGE_NAME, output);
    context.logger?.log({
      type: 'STAGE_COMPLETED',
      stage: STAGE_NAME,
      totalRounds: output.totalRounds,
      converged: output.converged
    });

    return output;
  } catch (error) {
    context.logger?.log({
      type: 'STAGE_FAILED',
      stage: STAGE_NAME,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}
