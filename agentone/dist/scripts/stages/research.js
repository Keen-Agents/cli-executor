import { runAgent } from '../lib/agent-runner.js';
import { CostTracker } from '../lib/cost-tracker.js';
import { TIMEOUTS } from '../pipeline-config.js';

const STAGE_NAME = 'research';
const COMPLETED_REGEX = /<COMPLETED>([\s\S]*?)<\/COMPLETED>/;

/**
 * Generate 3 research angle prompts from a task description.
 */
function generateAngles(description) {
  const base = description.trim();
  return [
    {
      label: 'landscape',
      prompt: [
        `Research the following topic broadly. Identify the major options, tools, frameworks, or approaches available.`,
        `Search the web for recent (2025-2026) information. Provide a thorough summary with sources.`,
        '',
        `Topic: ${base}`,
        '',
        `Focus on: What exists? What are the leading solutions? How do they compare at a high level?`,
        '',
        'Wrap your findings in:',
        '<COMPLETED>',
        '[Your research summary here]',
        '</COMPLETED>'
      ].join('\n')
    },
    {
      label: 'tradeoffs',
      prompt: [
        `Research the trade-offs and limitations of solutions for the following topic.`,
        `Search the web for real-world experience reports, benchmarks, and known issues (2025-2026).`,
        '',
        `Topic: ${base}`,
        '',
        `Focus on: Performance characteristics, scalability limits, learning curve, maintenance burden, community health, known pitfalls.`,
        '',
        'Wrap your findings in:',
        '<COMPLETED>',
        '[Your research summary here]',
        '</COMPLETED>'
      ].join('\n')
    },
    {
      label: 'recommendation',
      prompt: [
        `Based on current best practices, recommend the best approach for the following topic.`,
        `Search the web for expert opinions, recent articles, and community consensus (2025-2026).`,
        '',
        `Topic: ${base}`,
        '',
        `Focus on: What would you recommend for a production project starting today? Why? What are the runner-up options?`,
        '',
        'Wrap your findings in:',
        '<COMPLETED>',
        '[Your research summary here]',
        '</COMPLETED>'
      ].join('\n')
    }
  ];
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
 * Build the adversarial critique prompt for Codex.
 */
function buildCritiquePrompt(description, researchSummary) {
  return [
    `You are an adversarial research critic. Your job is to TEAR APART the research below — not to validate it.`,
    ``,
    `## Original Research Question`,
    description.trim(),
    ``,
    `## Research Findings (from Claude agents with web search)`,
    researchSummary,
    ``,
    `## Your Task`,
    ``,
    `Rip this research apart. You are NOT here to agree. Challenge everything:`,
    ``,
    `1. **Cherry-picked data** — Are benchmarks being cited selectively? Are sources biased or outdated? Would different metrics tell a different story?`,
    `2. **Missing perspectives** — What options, tools, or approaches did the research ignore? What blind spots exist?`,
    `3. **Unsupported claims** — Which recommendations lack hard evidence? Which "best practices" are actually just popularity contests?`,
    `4. **Logical gaps** — Does the ranking actually follow from the data? Are comparisons apples-to-apples?`,
    `5. **Recency bias** — Is this confusing "newest" with "best"? Are stable, proven solutions being overlooked for shiny new ones?`,
    `6. **Cost analysis holes** — Are TCO calculations realistic? Are hidden costs (infra, migration, lock-in) being ignored?`,
    `7. **Conflicting claims** — Point out where the research contradicts itself across sections.`,
    ``,
    `## Rules`,
    ``,
    `- Do NOT agree with the research. Do NOT say "the research is comprehensive" or "well-structured".`,
    `- Every sentence must identify a specific problem, ask a hard question, or challenge a specific claim.`,
    `- Cite the exact claims you're challenging. Use quotes.`,
    `- If you think a recommendation is wrong, say what the CORRECT recommendation is and why.`,
    `- Be blunt. Be specific. No filler.`,
    ``,
    `Wrap your critique in:`,
    `<COMPLETED>`,
    `[Your adversarial critique here]`,
    `</COMPLETED>`
  ].join('\n');
}

/**
 * Build the defense/convergence prompt for Claude.
 */
function buildDefensePrompt(description, researchSummary, critique) {
  return [
    `You are a research analyst responding to a harsh adversarial critique of your team's research.`,
    ``,
    `## Original Research Question`,
    description.trim(),
    ``,
    `## Your Team's Research Findings`,
    researchSummary,
    ``,
    `## Adversarial Critique (from Codex)`,
    critique,
    ``,
    `## Your Task`,
    ``,
    `Respond to every point in the critique. For each challenge:`,
    ``,
    `- **If the critic is RIGHT**: Concede explicitly. Say "Codex is correct here" and revise your position. Update the recommendation.`,
    `- **If the critic is WRONG**: Defend with specific evidence. Cite sources. Explain why the critique doesn't hold.`,
    `- **If it's a grey area**: Acknowledge the nuance. Present both sides fairly. Don't pretend certainty you don't have.`,
    ``,
    `Then produce a **FINAL CONVERGED SUMMARY** that incorporates the valid critiques and drops the debunked ones.`,
    `The converged summary should be BETTER than the original — sharper, more honest, with caveats where needed.`,
    ``,
    `## Rules`,
    ``,
    `- Do NOT dismiss the critique wholesale. At least SOME points will be valid — find them and concede.`,
    `- Do NOT be defensive. If the evidence doesn't support your original claim, change your position.`,
    `- The final summary must clearly mark where you changed your mind vs. held your ground.`,
    ``,
    `Structure your response as:`,
    `1. Point-by-point responses to the critique`,
    `2. Final converged research summary`,
    ``,
    `Wrap everything in:`,
    `<COMPLETED>`,
    `[Your defense + converged summary here]`,
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

    const angles = generateAngles(description);
    const timeout = TIMEOUTS.research || 300_000;
    const ticketKey = intakeOutput.key || 'unknown';

    context.logger?.log({
      type: 'GATE_CHECK',
      stage: STAGE_NAME,
      gate: 'research_spawn',
      angleCount: angles.length
    });

    // ── Phase 1: Parallel Claude research agents (web search) ─────────
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

    const results = await Promise.all(
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

    const successCount = results.filter((r) => r.success).length;
    if (successCount === 0) {
      throw new Error('All research agents failed. No results to synthesize.');
    }

    const researchSummary = mergeResults(angles, results);

    context.logger?.log({
      type: 'GATE_CHECK',
      stage: STAGE_NAME,
      gate: 'research_complete',
      successCount,
      totalAngles: angles.length
    });

    // ── Phase 2: Codex adversarial critique ───────────────────────────
    context.logger?.log({
      type: 'GATE_CHECK',
      stage: STAGE_NAME,
      gate: 'adversarial_critique_start'
    });

    const critiquePrompt = buildCritiquePrompt(description, researchSummary);
    let critiqueContent = null;

    try {
      const critiqueResult = await runAgent({
        cli: 'codex',
        prompt: critiquePrompt,
        cwd: context.workDir || undefined,
        timeout,
        label: `research-adversarial-critique-${ticketKey}`,
        metadata: {
          stage: STAGE_NAME,
          angle: 'adversarial-critique',
          ticketKey,
          runId: context.state.runId
        },
        extractRegex: COMPLETED_REGEX
      });

      if (context.costTracker && critiqueResult.sessionId) {
        context.costTracker.recordCall(STAGE_NAME, CostTracker.fromAgentResult(critiqueResult));
      }

      critiqueContent = critiqueResult.content || critiqueResult.fullOutput || null;

      context.logger?.log({
        type: 'GATE_CHECK',
        stage: STAGE_NAME,
        gate: 'adversarial_critique_done',
        success: critiqueResult.success,
        durationMs: critiqueResult.durationMs
      });
    } catch (err) {
      // Codex critique is best-effort — don't fail the whole stage
      context.logger?.log({
        type: 'GATE_CHECK',
        stage: STAGE_NAME,
        gate: 'adversarial_critique_failed',
        error: err instanceof Error ? err.message : String(err)
      });
    }

    // ── Phase 3: Claude defense + convergence ─────────────────────────
    let convergedSummary = researchSummary; // fallback if debate fails

    if (critiqueContent) {
      context.logger?.log({
        type: 'GATE_CHECK',
        stage: STAGE_NAME,
        gate: 'defense_convergence_start'
      });

      try {
        const defensePrompt = buildDefensePrompt(description, researchSummary, critiqueContent);
        const defenseResult = await runAgent({
          cli: 'claude',
          prompt: defensePrompt,
          cwd: context.workDir || undefined,
          timeout,
          label: `research-defense-convergence-${ticketKey}`,
          metadata: {
            stage: STAGE_NAME,
            angle: 'defense-convergence',
            ticketKey,
            runId: context.state.runId
          },
          extractRegex: COMPLETED_REGEX
        });

        if (context.costTracker && defenseResult.sessionId) {
          context.costTracker.recordCall(STAGE_NAME, CostTracker.fromAgentResult(defenseResult));
        }

        if (defenseResult.success && defenseResult.content) {
          convergedSummary = [
            researchSummary,
            '',
            '---',
            '',
            '# Adversarial Critique (Codex)',
            '',
            critiqueContent,
            '',
            '---',
            '',
            '# Defense & Converged Summary (Claude)',
            '',
            defenseResult.content
          ].join('\n');
        }

        context.logger?.log({
          type: 'GATE_CHECK',
          stage: STAGE_NAME,
          gate: 'defense_convergence_done',
          success: defenseResult.success,
          durationMs: defenseResult.durationMs
        });
      } catch (err) {
        // Defense is best-effort — fall back to research + critique
        convergedSummary = [
          researchSummary,
          '',
          '---',
          '',
          '# Adversarial Critique (Codex)',
          '',
          critiqueContent
        ].join('\n');

        context.logger?.log({
          type: 'GATE_CHECK',
          stage: STAGE_NAME,
          gate: 'defense_convergence_failed',
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    const output = {
      summary: convergedSummary,
      researchSummary,
      critique: critiqueContent,
      angles: angles.map((a, i) => ({
        label: a.label,
        success: results[i]?.success ?? false,
        sessionId: results[i]?.sessionId || null,
        durationMs: results[i]?.durationMs || 0
      })),
      hasAdversarialDebate: !!critiqueContent,
      successCount,
      totalAngles: angles.length
    };

    context.state.checkpoint(STAGE_NAME, output);
    context.logger?.log({
      type: 'STAGE_COMPLETED',
      stage: STAGE_NAME,
      successCount,
      totalAngles: angles.length,
      hasAdversarialDebate: !!critiqueContent
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
