import { runAgent } from '../lib/agent-runner.js';
import { CostTracker } from '../lib/cost-tracker.js';
import { TIMEOUTS, DEFAULTS } from '../pipeline-config.js';

const DEBATE_SAFETY_CAP = DEFAULTS.debateSafetyCap ?? 10;

const STAGE_NAME = 'research';
const COMPLETED_REGEX = /<COMPLETED>([\s\S]*?)<\/COMPLETED>/;
const CONVERGED_SIGNAL = '<CONVERGED>';
const RE_RESEARCH_REGEX = /<RE_RESEARCH>([\s\S]*?)<\/RE_RESEARCH>/;
const MAX_RE_RESEARCH_PER_DEBATE = 2;  // max re-research rounds to prevent runaway

const MAX_RESEARCH_AGENTS = 8;
const MIN_RESEARCH_AGENTS = 2;

/**
 * Fallback: generate 3 default research angles when dispatcher doesn't provide any.
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
 * Convert dispatcher-provided angles [{label, focus}] into research angle objects.
 */
function anglesFromInput(inputAngles, description) {
  return inputAngles
    .filter(a => a?.label && a?.focus)
    .slice(0, MAX_RESEARCH_AGENTS)
    .map(a => ({
      label: String(a.label).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30),
      prompt: buildAnglePrompt(description.trim(), a.label, a.focus)
    }));
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
    const exitedCleanly = result?.exitCode === 0;
    const status = (result?.success || exitedCleanly) ? 'completed' : (result?.timedOut ? 'timed out' : 'failed');

    parts.push(`## ${angle.label.charAt(0).toUpperCase() + angle.label.slice(1)} (${status})\n`);
    parts.push(content.trim());
    parts.push('');
  }

  return parts.join('\n');
}

/**
 * Parse RE_RESEARCH block from debate output into targeted research questions.
 * Expected format inside tags: JSON array of {label, focus} objects, or newline-separated questions.
 */
function parseReResearchBlock(content) {
  const match = content.match(RE_RESEARCH_REGEX);
  if (!match) return null;

  const raw = match[1].trim();
  // Try JSON array first
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.label && parsed[0]?.focus) {
      return parsed.slice(0, 3); // max 3 targeted questions
    }
  } catch {}

  // Fallback: numbered lines like "1. Research X\n2. Research Y"
  const lines = raw.split(/\n/).map(l => l.replace(/^\d+\.\s*/, '').trim()).filter(Boolean);
  if (lines.length === 0) return null;

  return lines.slice(0, 3).map((line, i) => ({
    label: `gap-${i + 1}`,
    focus: line
  }));
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
    `## Re-Research Signal`,
    ``,
    `If your critique reveals that the research is MISSING critical data that would change the`,
    `recommendation (e.g., outdated sources, unchecked competitor data, missing market stats),`,
    `you can request targeted re-research by including a <RE_RESEARCH> block:`,
    ``,
    `<RE_RESEARCH>`,
    `[{"label": "short-label", "focus": "What specific data to research and why it matters"}]`,
    `</RE_RESEARCH>`,
    ``,
    `The pipeline will spawn new research agents to fill these gaps, merge findings into the`,
    `research summary, and the debate will continue with the enriched data. Use this when your`,
    `web search alone cannot answer the question and dedicated deep research is needed.`,
    `Maximum 3 targeted questions per block. Only use this for CRITICAL gaps, not minor details.`,
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
      // ── Resolve research angles: dispatcher input → default fallback ──
      if (Array.isArray(context.angles) && context.angles.length >= MIN_RESEARCH_AGENTS) {
        angles = anglesFromInput(context.angles, description);
        context.logger?.log({
          type: 'GATE_CHECK',
          stage: STAGE_NAME,
          gate: 'angles_from_input',
          angleCount: angles.length,
          labels: angles.map(a => a.label)
        });
      } else {
        angles = generateDefaultAngles(description);
        context.logger?.log({
          type: 'GATE_CHECK',
          stage: STAGE_NAME,
          gate: 'angles_default',
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
          signal: context.signal,
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

      // Count as success if extractRegex matched OR if the agent exited cleanly (code 0)
      // with output. Agents sometimes forget <COMPLETED> tags but still produce valid research.
      successCount = results.filter((r) => r.success || (r.exitCode === 0 && (r.content || r.fullOutput))).length;
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
      let reResearchCount = 0;

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
          // Check abort signal before spawning a new debate round
          if (context.signal?.aborted) {
            context.logger?.log({ type: 'GATE_CHECK', stage: STAGE_NAME, gate: 'debate_aborted', round: round + 1 });
            break;
          }

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
              signal: context.signal,
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

            // ── Re-research: if debate identified critical gaps, spawn targeted agents ──
            const reResearchQuestions = parseReResearchBlock(roundContent);
            if (reResearchQuestions && reResearchCount < MAX_RE_RESEARCH_PER_DEBATE && !context.signal?.aborted) {
              reResearchCount++;
              context.logger?.log({
                type: 'GATE_CHECK',
                stage: STAGE_NAME,
                gate: 're_research_start',
                round: round + 1,
                questionCount: reResearchQuestions.length,
                labels: reResearchQuestions.map(q => q.label),
                reResearchRound: reResearchCount
              });

              const reResearchAngles = reResearchQuestions.map(q => ({
                label: q.label,
                prompt: buildAnglePrompt(description, q.label, q.focus)
              }));

              const reResults = await Promise.all(
                reResearchAngles.map(angle =>
                  runAgent({
                    cli: 'claude',
                    prompt: angle.prompt,
                    signal: context.signal,
                    cwd: context.workDir || undefined,
                    timeout,
                    label: `re-research-${angle.label}-${ticketKey}`,
                    metadata: {
                      stage: STAGE_NAME,
                      angle: `re-research-${angle.label}`,
                      ticketKey,
                      runId: context.state.runId
                    },
                    extraArgs: ['--allowedTools', 'WebSearch,WebFetch'],
                    extractRegex: COMPLETED_REGEX
                  }).catch(err => ({
                    success: false,
                    content: null,
                    fullOutput: `Error: ${err instanceof Error ? err.message : String(err)}`,
                    exitCode: null
                  }))
                )
              );

              // Record costs
              for (const rr of reResults) {
                if (context.costTracker && rr.sessionId) {
                  context.costTracker.recordCall(STAGE_NAME, CostTracker.fromAgentResult(rr));
                }
              }

              const reResearchSummary = mergeResults(reResearchAngles, reResults);
              const reSuccessCount = reResults.filter(r => r.success || (r.exitCode === 0 && (r.content || r.fullOutput))).length;

              // Merge into main research summary
              researchSummary += `\n\n---\n\n# Re-Research (triggered by debate round ${round + 1})\n\n${reResearchSummary}`;

              context.logger?.log({
                type: 'GATE_CHECK',
                stage: STAGE_NAME,
                gate: 're_research_done',
                round: round + 1,
                successCount: reSuccessCount,
                totalQuestions: reResearchQuestions.length
              });
            }

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

    if (debateHistory.length > 0 && !context.signal?.aborted) {
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
          signal: context.signal,
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
