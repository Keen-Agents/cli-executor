import { runAgent } from '../lib/agent-runner.js';
import { CostTracker } from '../lib/cost-tracker.js';
import { TIMEOUTS } from '../pipeline-config.js';

const STAGE_NAME = 'research';
const COMPLETED_REGEX = /<COMPLETED>([\s\S]*?)<\/COMPLETED>/;

/**
 * Generate 2-3 research angle prompts from a task description.
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

    context.logger?.log({
      type: 'GATE_CHECK',
      stage: STAGE_NAME,
      gate: 'research_spawn',
      angleCount: angles.length
    });

    // Spawn all research agents in parallel
    const agentPromises = angles.map((angle) =>
      runAgent({
        cli: 'claude',
        prompt: angle.prompt,
        cwd: context.workDir || undefined,
        timeout,
        label: `research-${angle.label}-${intakeOutput.key || 'unknown'}`,
        metadata: {
          stage: STAGE_NAME,
          angle: angle.label,
          ticketKey: intakeOutput.key,
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

    const summary = mergeResults(angles, results);

    const output = {
      summary,
      angles: angles.map((a, i) => ({
        label: a.label,
        success: results[i]?.success ?? false,
        sessionId: results[i]?.sessionId || null,
        durationMs: results[i]?.durationMs || 0
      })),
      successCount,
      totalAngles: angles.length
    };

    context.state.checkpoint(STAGE_NAME, output);
    context.logger?.log({
      type: 'STAGE_COMPLETED',
      stage: STAGE_NAME,
      successCount,
      totalAngles: angles.length
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
