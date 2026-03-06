import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runAgent } from '../lib/agent-runner.js';
import { CostTracker } from '../lib/cost-tracker.js';
import { assembleContext } from '../lib/context-assembler.js';
import { TIMEOUTS } from '../pipeline-config.js';

const STAGE_NAME = 'dual-plan';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLAUDE_PROMPT_PATH = resolve(__dirname, '../prompts/plan-claude.md');
const CODEX_PROMPT_PATH = resolve(__dirname, '../prompts/plan-codex.md');

function toStringValue(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

function renderPrompt(template, ticket, classify) {
  const labels = Array.isArray(ticket.labels) ? ticket.labels.join(', ') : '';
  const replacements = {
    '{{TICKET_KEY}}': toStringValue(ticket.key),
    '{{TICKET_SUMMARY}}': toStringValue(ticket.summary),
    '{{TICKET_DESCRIPTION}}': toStringValue(ticket.description),
    '{{TICKET_TYPE}}': toStringValue(ticket.ticketType),
    '{{LABELS}}': labels,
    '{{PROFILE}}': toStringValue(classify.profile)
  };

  let rendered = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    rendered = rendered.split(placeholder).join(value);
  }
  return rendered;
}

function mergePlans(claudeContent, codexContent) {
  const parts = [];

  if (claudeContent) {
    parts.push('## Claude Agent Plan (Architecture & Risk Focus)\n');
    parts.push(claudeContent);
    parts.push('');
  }

  if (codexContent) {
    parts.push('## Codex Agent Plan (Implementation & Code Focus)\n');
    parts.push(codexContent);
    parts.push('');
  }

  parts.push('## Synthesis');
  parts.push('The above plans represent two independent perspectives on the same ticket.');
  parts.push('Claude focused on architecture, risk, and edge cases.');
  parts.push('Codex focused on concrete file changes, code patterns, and execution order.');
  parts.push('The cross-critique stage should reconcile divergent approaches and produce a unified plan.');

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
    const ticket = context.state.getStageOutput('intake');
    if (!ticket || typeof ticket !== 'object') {
      throw new Error('Dual-plan stage requires intake output from stage "intake".');
    }
    const classify = resolveProfile(context.state);
    if (!classify || typeof classify !== 'object') {
      throw new Error('Dual-plan stage requires a resolved profile from state or stage "classify".');
    }

    const claudeTemplate = readFileSync(CLAUDE_PROMPT_PATH, 'utf8');
    const codexTemplate = readFileSync(CODEX_PROMPT_PATH, 'utf8');
    let claudePrompt = renderPrompt(claudeTemplate, ticket, classify);
    let codexPrompt = renderPrompt(codexTemplate, ticket, classify);

    const contextBlock = assembleContext(context.state, 'plan', 100000);
    if (contextBlock) {
      claudePrompt += '\n\n## Additional Context\n' + contextBlock;
      codexPrompt += '\n\n## Additional Context\n' + contextBlock;
    }

    const humanRevision = context.state.getLatestHumanRevision?.();
    if (humanRevision?.comments) {
      const revisionBlock = `\n\n## Human Revision Request\n${humanRevision.comments}`;
      claudePrompt += revisionBlock;
      codexPrompt += revisionBlock;
    }

    const timeout = TIMEOUTS['dual-plan'] || 420_000;
    const ticketKey = toStringValue(ticket.key) || 'unknown';

    context.logger?.log({
      type: 'SESSION_SPAWNED',
      stage: STAGE_NAME,
      agents: ['claude', 'codex'],
      ticketKey
    });

    // Spawn both agents in parallel
    const [claudeResult, codexResult] = await Promise.all([
      runAgent({
        cli: 'claude',
        prompt: claudePrompt,
        cwd: context.workDir || undefined,
        timeout,
        label: `dual-plan-claude-${ticketKey}`,
        metadata: {
          stage: STAGE_NAME,
          agent: 'claude',
          ticketKey,
          runId: context.state.runId
        }
      }),
      runAgent({
        cli: 'codex',
        prompt: codexPrompt,
        cwd: context.workDir || undefined,
        timeout,
        label: `dual-plan-codex-${ticketKey}`,
        metadata: {
          stage: STAGE_NAME,
          agent: 'codex',
          ticketKey,
          runId: context.state.runId
        }
      })
    ]);

    // Record costs for both agents
    if (context.costTracker) {
      context.costTracker.recordCall(STAGE_NAME, CostTracker.fromAgentResult(claudeResult));
      context.costTracker.recordCall(STAGE_NAME, CostTracker.fromAgentResult(codexResult));
    }

    const claudeContent = claudeResult.content?.trim() || null;
    const codexContent = codexResult.content?.trim() || null;
    const claudeOk = claudeResult.success && claudeContent;
    const codexOk = codexResult.success && codexContent;

    // Handle failures with fallback
    if (!claudeOk && !codexOk) {
      const reasons = [];
      if (claudeResult.timedOut) reasons.push(`Claude timed out after ${claudeResult.durationMs}ms`);
      else if (!claudeContent) reasons.push('Claude produced no <COMPLETED> content');
      if (codexResult.timedOut) reasons.push(`Codex timed out after ${codexResult.durationMs}ms`);
      else if (!codexContent) reasons.push('Codex produced no <COMPLETED> content');
      throw new Error(`Both agents failed to produce a plan: ${reasons.join('; ')}`);
    }

    if (!claudeOk) {
      context.logger?.log({
        type: 'STAGE_COMPLETED',
        stage: STAGE_NAME,
        degraded: true,
        failedAgent: 'claude',
        reason: claudeResult.timedOut ? 'timeout' : 'no-content'
      });
    }

    if (!codexOk) {
      context.logger?.log({
        type: 'STAGE_COMPLETED',
        stage: STAGE_NAME,
        degraded: true,
        failedAgent: 'codex',
        reason: codexResult.timedOut ? 'timeout' : 'no-content'
      });
    }

    const mergedPlan = mergePlans(claudeContent, codexContent);

    const output = {
      plan: mergedPlan,
      claudePlan: {
        content: claudeContent,
        sessionId: claudeResult.sessionId || null,
        durationMs: claudeResult.durationMs,
        success: Boolean(claudeOk)
      },
      codexPlan: {
        content: codexContent,
        sessionId: codexResult.sessionId || null,
        durationMs: codexResult.durationMs,
        success: Boolean(codexOk)
      },
      mergeStrategy: 'combined',
      totalDurationMs: Math.max(claudeResult.durationMs || 0, codexResult.durationMs || 0)
    };

    context.state.checkpoint(STAGE_NAME, output);
    context.logger?.log({
      type: 'STAGE_COMPLETED',
      stage: STAGE_NAME,
      claudeSuccess: output.claudePlan.success,
      codexSuccess: output.codexPlan.success,
      totalDurationMs: output.totalDurationMs
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
