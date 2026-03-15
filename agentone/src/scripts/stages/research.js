import { runAgent } from '../lib/agent-runner.js';
import { CostTracker } from '../lib/cost-tracker.js';
import { TIMEOUTS, DEFAULTS } from '../pipeline-config.js';

const DEBATE_SAFETY_CAP = DEFAULTS.debateSafetyCap ?? 10;

const STAGE_NAME = 'research';
const COMPLETED_REGEX = /<COMPLETED>([\s\S]*?)<\/COMPLETED>/;
const CONVERGED_SIGNAL = '<CONVERGED>';

const PLANNER_JSON_REGEX = /<COMPLETED>([\s\S]*?)<\/COMPLETED>/;
const MAX_RESEARCH_AGENTS = 8;
const MIN_RESEARCH_AGENTS = 2;

/**
 * Fallback: generate 3 default research angles if the planner agent fails.
 */
function generateDefaultAngles(description) {
  const base = description.trim();
  return [
    { label: 'landscape', focus: 'What exists? What are the leading solutions? How do they compare at a high level?' },
    { label: 'tradeoffs', focus: 'Performance, scalability, learning curve, maintenance burden, community health, known pitfalls.' },
    { label: 'recommendation', focus: 'What would you recommend for a production project starting today? Why? Runner-up options?' }
  ].map(a => ({
    label: a.label,
    prompt: buildAnglePrompt(base, a.label, a.focus)
  }));
}

/**
 * Build a research prompt for a single angle.
 */
function buildAnglePrompt(topic, label, focus) {
  return [
    `Research the following topic from the perspective of: **${label}**.`,
    `Search the web for recent (2025-2026) information. Go to primary sources — official reports, data platforms, company blogs with real numbers. Avoid listicles and aggregation blogs.`,
    '',
    `Topic: ${topic}`,
    '',
    `Focus on: ${focus}`,
    `Cite URLs for every claim.`,
    '',
    'Wrap your findings in:',
    '<COMPLETED>',
    '[Your research summary here]',
    '</COMPLETED>'
  ].join('\n');
}

/**
 * Use a planner agent to decide what research angles are needed.
 * Returns an array of {label, prompt} objects — the planner decides how many (2-8).
 */
async function planResearchAngles(description, context, ticketKey, timeout) {
  const plannerPrompt = [
    `You are a research planning agent. Given a topic, decide what research angles are needed for thorough coverage.`,
    ``,
    `## Topic`,
    description.trim(),
    ``,
    `## Your Task`,
    `Decide the research angles needed to thoroughly investigate this topic. Each angle will be given to a separate research agent that will search the web independently.`,
    ``,
    `Guidelines:`,
    `- Use ${MIN_RESEARCH_AGENTS}-${MAX_RESEARCH_AGENTS} angles depending on topic complexity`,
    `- Simple topics (e.g., "best CLI tool for X") need 2-3 angles`,
    `- Complex topics (e.g., "design a microservices architecture for e-commerce") need 5-8 angles`,
    `- Each angle should cover a DISTINCT aspect — no overlap`,
    `- Each angle needs a short label (1-3 words, lowercase, hyphens) and a focus description`,
    ``,
    `## Output Format`,
    ``,
    `Respond with EXACTLY this JSON array inside COMPLETED tags. No other text.`,
    ``,
    `<COMPLETED>`,
    `[`,
    `  {"label": "short-label", "focus": "What this angle should investigate"},`,
    `  {"label": "another-angle", "focus": "What this angle should investigate"}`,
    `]`,
    `</COMPLETED>`
  ].join('\n');

  try {
    const result = await runAgent({
      cli: 'claude',
      prompt: plannerPrompt,
      cwd: context.workDir || undefined,
      timeout: Math.min(timeout, 120_000),
      label: `research-planner-${ticketKey}`,
      metadata: {
        stage: STAGE_NAME,
        angle: 'planner',
        ticketKey,
        runId: context.state.runId
      },
      extractRegex: PLANNER_JSON_REGEX
    });

    if (context.costTracker && result.sessionId) {
      context.costTracker.recordCall(STAGE_NAME, CostTracker.fromAgentResult(result));
    }

    if (!result.success || !result.content) {
      context.logger?.log({ type: 'GATE_CHECK', stage: STAGE_NAME, gate: 'planner_failed', reason: 'no content' });
      return null;
    }

    const parsed = JSON.parse(result.content);
    if (!Array.isArray(parsed) || parsed.length < MIN_RESEARCH_AGENTS) {
      context.logger?.log({ type: 'GATE_CHECK', stage: STAGE_NAME, gate: 'planner_failed', reason: 'invalid array', length: parsed?.length });
      return null;
    }

    // Validate and cap
    const angles = parsed
      .filter(a => a?.label && a?.focus)
      .slice(0, MAX_RESEARCH_AGENTS)
      .map(a => ({
        label: String(a.label).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30),
        prompt: buildAnglePrompt(description.trim(), a.label, a.focus)
      }));

    if (angles.length < MIN_RESEARCH_AGENTS) {
      context.logger?.log({ type: 'GATE_CHECK', stage: STAGE_NAME, gate: 'planner_failed', reason: 'too few valid angles', count: angles.length });
      return null;
    }

    return angles;
  } catch (err) {
    context.logger?.log({
      type: 'GATE_CHECK',
      stage: STAGE_NAME,
      gate: 'planner_failed',
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

/**
 * Merge research results into a structured summary.
 */
function mergeResults(angles, results) {
  const parts = ['# Research Summary\n'];

  for (let i = 0; i < angles.length; i++) {
    const angle = angles[i];
    const result = results[i];
    const content = result?.content || result?.fullOutput || '(no output)';
    const status = result?.success ? 'completed' : (result?.timedOut ? 'timed out' : 'failed');

    parts.push(`## ${angle.label.charAt(0).toUpperCase() + angle.label.slice(1)} (${status})\n`);
    parts.push(content.trim());
    parts.push('');
  }

  return parts.join('\n');
}

/**
 * Build a debate prompt for alternating Claude/Codex adversarial rounds.
 * @param {boolean} [isAutoMode] — if true, no fixed round limit; AIs debate until genuine convergence.
 */
function buildDebatePrompt(description, researchSummary, debateHistory, round, isAutoMode = true) {
  const cli = round % 2 === 0 ? 'Claude' : 'Codex';
  const opponent = round % 2 === 0 ? 'Codex' : 'Claude';

  const sections = [
    `You are an adversarial research critic (${cli}). Your opponent is ${opponent}.`,
    ``,
    `## Original Research Question`,
    description.trim(),
    ``,
    `## Research Findings (from Claude agents with web search)`,
    researchSummary,
  ];

  if (debateHistory.length > 0) {
    sections.push('');
    sections.push(`## Debate History`);
    for (const entry of debateHistory) {
      const who = entry.cli === 'claude' ? 'Claude' : 'Codex';
      sections.push('');
      sections.push(`### Round ${entry.round + 1} (${who})`);
      sections.push(entry.content);
    }
  }

  sections.push('');
  sections.push(`## Your Task (Round ${round + 1})`);
  sections.push('');

  if (round === 0) {
    sections.push(
      `This is the FIRST critique round. Tear apart the research above:`,
      ``,
      `1. **Cherry-picked data** — Are sources biased or outdated? Would different metrics tell a different story?`,
      `2. **Missing perspectives** — What did the research ignore? What blind spots exist?`,
      `3. **Unsupported claims** — Which recommendations lack hard evidence?`,
      `4. **Logical gaps** — Does the ranking follow from the data?`,
      `5. **Conflicting claims** — Point out contradictions across sections.`,
      ``,
      `USE YOUR WEB SEARCH to fact-check specific claims. Find counter-evidence. Cite URLs.`,
    );
  } else {
    sections.push(
      `Read the previous round's critique carefully. Counter-critique it:`,
      ``,
      `- Where is the previous critic WRONG? Find evidence to disprove their points. Use web search.`,
      `- Where is the previous critic RIGHT? Concede explicitly and update the recommendation.`,
      `- Where did the previous critic introduce NEW errors or unsupported claims? Call them out.`,
      `- Cite URLs for every counter-argument.`,
    );
  }

  if (isAutoMode) {
    sections.push(
      ``,
      `## Convergence Rule (AUTO MODE — no fixed round limit)`,
      ``,
      `This debate has NO predetermined number of rounds. You will keep debating until BOTH sides`,
      `genuinely agree. There is no pressure to converge early — take as many rounds as needed.`,
      ``,
      `Signal convergence ONLY when you GENUINELY believe:`,
      `- The core factual claims have been verified or corrected by BOTH sides`,
      `- All contradictions have been resolved with evidence`,
      `- The final recommendation is supported by evidence from multiple sources`,
      `- Further rounds would NOT produce meaningful new insights`,
      ``,
      `When you are ready to converge, respond with ${CONVERGED_SIGNAL} followed by the final recommendation.`,
      ``,
      `If there are ANY unresolved factual disputes, missing evidence, or unanswered counter-arguments,`,
      `you MUST keep arguing. Do NOT agree politely. Do NOT converge just because several rounds have passed.`,
    );
  } else {
    sections.push(
      ``,
      `## Convergence Rule`,
      ``,
      `If you believe the debate has converged — the research + critiques have produced a solid,`,
      `well-validated recommendation that further argument would NOT meaningfully improve — then`,
      `respond with ${CONVERGED_SIGNAL} followed by the final agreed recommendation.`,
      ``,
      `But do NOT converge prematurely. Only converge if:`,
      `- The core factual claims have been verified or corrected`,
      `- Contradictions have been resolved`,
      `- The final recommendation is supported by evidence from multiple sources`,
      ``,
      `If there are still unresolved factual disputes, KEEP ARGUING. Do NOT agree politely.`,
    );
  }

  sections.push(
    ``,
    `## Rules`,
    ``,
    `- Do NOT agree with prior arguments just to be nice. Every sentence must add value.`,
    `- Cite exact claims you're challenging. Use quotes.`,
    `- If you think a recommendation is wrong, say what the CORRECT one is and why.`,
    `- Be blunt. Be specific. No filler.`,
    ``,
    `Wrap your response in:`,
    `<COMPLETED>`,
    `[Your critique OR ${CONVERGED_SIGNAL} + final recommendation here]`,
    `</COMPLETED>`
  );

  return sections.join('\n');
}

/**
 * Build the validation prompt for Claude.
 */
function buildValidationPrompt(description, researchSummary, debateHistory) {
  const debateText = debateHistory.map(d => {
    const who = d.cli === 'claude' ? 'Claude' : 'Codex';
    return `### Round ${d.round + 1} (${who})\n${d.content}`;
  }).join('\n\n');

  return [
    `You are a research validation agent. You have just witnessed a full adversarial debate about a research question.`,
    `Your job is to extract a STRUCTURED VERDICT from the debate.`,
    ``,
    `## Original Research Question`,
    description.trim(),
    ``,
    `## Original Research Findings`,
    researchSummary,
    ``,
    `## Adversarial Debate`,
    debateText,
    ``,
    `## Your Task`,
    ``,
    `Analyze the full debate and answer these questions:`,
    ``,
    `1. **Did the original #1 recommendation survive the critique?** If the critique proved fatal flaws`,
    `   (e.g., the recommended approach is technically impossible, legally blocked, or based on false assumptions),`,
    `   then the recommendation did NOT survive.`,
    `2. **What is the final recommendation?** State the recommended approach clearly.`,
    `3. **How confident are you in this recommendation?** Score 0-100 where:`,
    `   - 0-30: Recommendation is fundamentally flawed or unvalidated`,
    `   - 31-60: Recommendation has significant concerns but may be viable`,
    `   - 61-80: Recommendation is solid with known caveats`,
    `   - 81-100: Recommendation is well-supported and validated`,
    ``,
    `## Output Format`,
    ``,
    `You MUST respond with EXACTLY this JSON structure inside the COMPLETED tags.`,
    `Do NOT include any text outside the JSON. Do NOT use markdown code blocks inside the tags.`,
    ``,
    `<COMPLETED>`,
    `{`,
    `  "recommendationSurvived": true or false,`,
    `  "finalRecommendation": {`,
    `    "name": "Name of the recommended approach",`,
    `    "description": "One paragraph summary of what to build/do",`,
    `    "confidence": 0-100`,
    `  },`,
    `  "verdict": "One paragraph explaining your reasoning"`,
    `}`,
    `</COMPLETED>`
  ].join('\n');
}

export async function run(context) {
  context.state.stageStart(STAGE_NAME);
  context.logger?.log({ type: 'STAGE_STARTED', stage: STAGE_NAME });

  try {
    const intakeOutput = context.state.getStageOutput('intake');
    if (!intakeOutput || typeof intakeOutput !== 'object') {
      throw new Error('Research stage requires intake output.');
    }

    const description = intakeOutput.description || intakeOutput.summary || '';
    if (!description.trim()) {
      throw new Error('Research stage requires a non-empty task description.');
    }

    const timeout = TIMEOUTS.research || 300_000;
    const ticketKey = intakeOutput.key || 'unknown';

    // ── Check for sub-stage checkpoints (resume support) ─────────────
    const phase1Checkpoint = context.state.getStageOutput('research-phase1');
    let researchSummary;
    let successCount;
    let results;
    let angles;

    if (phase1Checkpoint) {
      // Resume: Phase 1 already completed
      context.logger?.log({ type: 'GATE_CHECK', stage: STAGE_NAME, gate: 'phase1_resumed' });
      researchSummary = phase1Checkpoint.researchSummary;
      successCount = phase1Checkpoint.successCount;
      results = phase1Checkpoint.results;
      angles = (phase1Checkpoint.results || []).map(r => ({ label: r.label, prompt: '' }));
    } else {
      // ── Phase 0: Planner decides research angles ────────────────────
      context.logger?.log({ type: 'GATE_CHECK', stage: STAGE_NAME, gate: 'planner_start' });

      const plannedAngles = await planResearchAngles(description, context, ticketKey, timeout);
      if (plannedAngles) {
        angles = plannedAngles;
        context.logger?.log({
          type: 'GATE_CHECK',
          stage: STAGE_NAME,
          gate: 'planner_done',
          angleCount: angles.length,
          labels: angles.map(a => a.label)
        });
      } else {
        angles = generateDefaultAngles(description);
        context.logger?.log({
          type: 'GATE_CHECK',
          stage: STAGE_NAME,
          gate: 'planner_fallback',
          angleCount: angles.length,
          labels: angles.map(a => a.label)
        });
      }

      // ── Phase 1: Parallel Claude research agents (web search) ──────
      context.logger?.log({
        type: 'GATE_CHECK',
        stage: STAGE_NAME,
        gate: 'research_spawn',
        angleCount: angles.length
      });

      const agentPromises = angles.map((angle) =>
        runAgent({
          cli: 'claude',
          prompt: angle.prompt,
          cwd: context.workDir || undefined,
          timeout,
          label: `research-${angle.label}-${ticketKey}`,
          metadata: {
            stage: STAGE_NAME,
            angle: angle.label,
            ticketKey,
            runId: context.state.runId
          },
          extraArgs: ['--allowedTools', 'WebSearch,WebFetch'],
          extractRegex: COMPLETED_REGEX
        })
      );

      results = await Promise.all(
        agentPromises.map((p) => p.catch((err) => ({
          success: false,
          content: null,
          fullOutput: `Error: ${err instanceof Error ? err.message : String(err)}`,
          timedOut: false,
          durationMs: 0
        })))
      );

      // Record costs
      for (const result of results) {
        if (context.costTracker && result.sessionId) {
          context.costTracker.recordCall(STAGE_NAME, CostTracker.fromAgentResult(result));
        }
      }

      successCount = results.filter((r) => r.success).length;
      // Need at least half of the angles (min 2) to succeed
      const MIN_ANGLES_REQUIRED = Math.max(2, Math.ceil(angles.length / 2));

      if (successCount === 0) {
        throw new Error('All research agents failed. No results to synthesize.');
      }

      if (successCount < MIN_ANGLES_REQUIRED) {
        const failedAngles = angles
          .filter((_, i) => !results[i]?.success)
          .map((a) => {
            const idx = angles.indexOf(a);
            const r = results[idx];
            const reason = r?.timedOut ? 'timed out' : 'failed';
            return `${a.label} (${reason})`;
          });
        throw new Error(
          `Research requires at least ${MIN_ANGLES_REQUIRED} of ${angles.length} angles to succeed, ` +
          `but only ${successCount} succeeded. Failed: ${failedAngles.join(', ')}. ` +
          `Re-run with longer timeouts or retry.`
        );
      }

      researchSummary = mergeResults(angles, results);

      // Checkpoint Phase 1 — if debate or validation fails, we resume here
      const phase1Data = {
        researchSummary,
        successCount,
        results: results.map((r, i) => ({
          success: r.success ?? false,
          content: r.content || null,
          fullOutput: r.fullOutput || null,
          sessionId: r.sessionId || null,
          durationMs: r.durationMs || 0,
          timedOut: r.timedOut || false,
          label: angles[i].label
        }))
      };
      context.state.checkpoint('research-phase1', phase1Data);

      context.logger?.log({
        type: 'GATE_CHECK',
        stage: STAGE_NAME,
        gate: 'research_complete',
        successCount,
        totalAngles: angles.length
      });
    }

    // ── Phase 2: Alternating adversarial debate ──────────────────────
    const debateCheckpoint = context.state.getStageOutput('research-debate');
    let debateHistory;
    let converged;

    if (debateCheckpoint) {
      // Resume: debate already completed
      context.logger?.log({ type: 'GATE_CHECK', stage: STAGE_NAME, gate: 'debate_resumed' });
      debateHistory = debateCheckpoint.debateHistory;
      converged = debateCheckpoint.converged;
    } else {
      const rawRounds = context.config?.maxConvergenceRounds ?? DEFAULTS.maxConvergenceRounds ?? 'auto';
      const isAutoMode = rawRounds === 'auto' || rawRounds === -1;
      const MAX_DEBATE_ROUNDS = isAutoMode ? DEBATE_SAFETY_CAP : Number(rawRounds);
      debateHistory = [];
      converged = false;

      // Check for partial debate checkpoint (individual rounds saved)
      for (let r = 0; r < MAX_DEBATE_ROUNDS; r++) {
        const roundCheckpoint = context.state.getStageOutput(`research-debate-round-${r}`);
        if (roundCheckpoint) {
          debateHistory.push(roundCheckpoint);
          if (roundCheckpoint.content?.includes(CONVERGED_SIGNAL)) {
            converged = true;
          }
        }
      }

      if (debateHistory.length > 0 && !converged) {
        context.logger?.log({
          type: 'GATE_CHECK',
          stage: STAGE_NAME,
          gate: 'debate_partial_resume',
          completedRounds: debateHistory.length
        });
      }

      if (!converged) {
        context.logger?.log({
          type: 'GATE_CHECK',
          stage: STAGE_NAME,
          gate: 'debate_start',
          mode: isAutoMode ? 'auto' : 'fixed',
          maxRounds: MAX_DEBATE_ROUNDS,
          safetyCap: isAutoMode ? DEBATE_SAFETY_CAP : undefined,
          startingFrom: debateHistory.length
        });

        for (let round = debateHistory.length; round < MAX_DEBATE_ROUNDS; round++) {
          const cli = round % 2 === 0 ? 'claude' : 'codex';
          const extraArgs = cli === 'claude'
            ? ['--allowedTools', 'WebSearch,WebFetch']
            : ['-c', 'search=true', '--dangerously-bypass-approvals-and-sandbox'];

          const debatePrompt = buildDebatePrompt(description, researchSummary, debateHistory, round, isAutoMode);

          context.logger?.log({
            type: 'GATE_CHECK',
            stage: STAGE_NAME,
            gate: 'debate_round_start',
            round: round + 1,
            cli
          });

          try {
            const debateResult = await runAgent({
              cli,
              prompt: debatePrompt,
              cwd: context.workDir || undefined,
              timeout,
              label: `debate-round-${round + 1}-${cli}-${ticketKey}`,
              metadata: {
                stage: STAGE_NAME,
                angle: `debate-round-${round + 1}`,
                cli,
                ticketKey,
                runId: context.state.runId
              },
              extraArgs,
              extractRegex: COMPLETED_REGEX
            });

            if (context.costTracker && debateResult.sessionId) {
              context.costTracker.recordCall(STAGE_NAME, CostTracker.fromAgentResult(debateResult));
            }

            const roundContent = debateResult.content || debateResult.fullOutput || '';
            const roundData = { round, cli, content: roundContent };
            debateHistory.push(roundData);

            // Checkpoint each debate round individually
            context.state.checkpoint(`research-debate-round-${round}`, roundData);

            context.logger?.log({
              type: 'GATE_CHECK',
              stage: STAGE_NAME,
              gate: 'debate_round_done',
              round: round + 1,
              cli,
              success: debateResult.success,
              durationMs: debateResult.durationMs
            });

            if (roundContent.includes(CONVERGED_SIGNAL)) {
              converged = true;
              context.logger?.log({
                type: 'GATE_CHECK',
                stage: STAGE_NAME,
                gate: 'debate_converged',
                round: round + 1,
                cli
              });
              break;
            }
          } catch (err) {
            context.logger?.log({
              type: 'GATE_CHECK',
              stage: STAGE_NAME,
              gate: 'debate_round_failed',
              round: round + 1,
              cli,
              error: err instanceof Error ? err.message : String(err)
            });
            break;
          }
        }
      }

      if (!converged && debateHistory.length >= MAX_DEBATE_ROUNDS) {
        context.logger?.log({
          type: 'GATE_CHECK',
          stage: STAGE_NAME,
          gate: isAutoMode ? 'debate_safety_cap_reached' : 'debate_max_rounds_reached',
          totalRounds: debateHistory.length,
          safetyCap: isAutoMode ? DEBATE_SAFETY_CAP : undefined
        });
      }

      // Checkpoint full debate result
      context.state.checkpoint('research-debate', { debateHistory, converged });
    }

    // Build converged summary from research + debate
    let convergedSummary = researchSummary;
    if (debateHistory.length > 0) {
      const debateSections = debateHistory.map(d => {
        const who = d.cli === 'claude' ? 'Claude' : 'Codex';
        return `\n---\n\n# Debate Round ${d.round + 1} (${who})\n\n${d.content}`;
      });
      convergedSummary = [researchSummary, ...debateSections].join('\n');
    }

    // ── Phase 3: Validation — did the recommendation survive? ───────
    let validation = null;

    if (debateHistory.length > 0) {
      context.logger?.log({
        type: 'GATE_CHECK',
        stage: STAGE_NAME,
        gate: 'validation_start'
      });

      try {
        const validationPrompt = buildValidationPrompt(
          description, researchSummary, debateHistory
        );
        const validationResult = await runAgent({
          cli: 'claude',
          prompt: validationPrompt,
          cwd: context.workDir || undefined,
          timeout: timeout > 120_000 ? 120_000 : timeout,
          label: `research-validation-${ticketKey}`,
          metadata: {
            stage: STAGE_NAME,
            angle: 'validation',
            ticketKey,
            runId: context.state.runId
          },
          extractRegex: COMPLETED_REGEX
        });

        if (context.costTracker && validationResult.sessionId) {
          context.costTracker.recordCall(STAGE_NAME, CostTracker.fromAgentResult(validationResult));
        }

        if (validationResult.success && validationResult.content) {
          try {
            validation = JSON.parse(validationResult.content);
          } catch {
            context.logger?.log({
              type: 'GATE_CHECK',
              stage: STAGE_NAME,
              gate: 'validation_parse_failed',
              contentPreview: validationResult.content.slice(0, 200)
            });
          }
        }

        context.logger?.log({
          type: 'GATE_CHECK',
          stage: STAGE_NAME,
          gate: 'validation_done',
          success: validationResult.success,
          recommendationSurvived: validation?.recommendationSurvived ?? null,
          confidence: validation?.finalRecommendation?.confidence ?? null,
          durationMs: validationResult.durationMs
        });
      } catch (err) {
        context.logger?.log({
          type: 'GATE_CHECK',
          stage: STAGE_NAME,
          gate: 'validation_failed',
          error: err instanceof Error ? err.message : String(err)
        });
      }

      // Hard fail: recommendation was killed and no viable alternative emerged
      if (validation && validation.recommendationSurvived === false) {
        const confidence = validation.finalRecommendation?.confidence ?? 0;
        if (confidence < 31) {
          throw new Error(
            `Research recommendation did not survive adversarial review. ` +
            `Confidence: ${confidence}/100. ` +
            `Verdict: ${validation.verdict || 'No viable recommendation emerged from the debate.'}. ` +
            `The pipeline cannot proceed without a validated research recommendation.`
          );
        }
      }
    }

    const resultAngles = (results || phase1Checkpoint?.results || []);
    const output = {
      summary: convergedSummary,
      researchSummary,
      debateRounds: debateHistory,
      convergedNaturally: converged,
      critique: debateHistory[0]?.content || null,
      angles: angles.map((a, i) => ({
        label: a.label,
        success: resultAngles[i]?.success ?? false,
        sessionId: resultAngles[i]?.sessionId || null,
        durationMs: resultAngles[i]?.durationMs || 0
      })),
      hasAdversarialDebate: debateHistory.length > 0,
      successCount,
      totalAngles: angles.length,
      validation: validation || null,
      recommendationSurvived: validation?.recommendationSurvived ?? null,
      finalRecommendation: validation?.finalRecommendation || null
    };

    context.state.checkpoint(STAGE_NAME, output);
    context.logger?.log({
      type: 'STAGE_COMPLETED',
      stage: STAGE_NAME,
      successCount,
      totalAngles: angles.length,
      hasAdversarialDebate: debateHistory.length > 0,
      debateRounds: debateHistory.length,
      convergedNaturally: converged
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
