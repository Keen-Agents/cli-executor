import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runAgent } from '../lib/agent-runner.js';
import { CostTracker } from '../lib/cost-tracker.js';
import { assembleContext } from '../lib/context-assembler.js';
import { TIMEOUTS } from '../pipeline-config.js';

const STAGE_NAME = 'plan';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLAN_PROMPT_TEMPLATE_PATH = resolve(__dirname, '../prompts/plan.md');

function toStringValue(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function renderPlanPrompt(template, ticket, classify) {
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

export async function run(context) {
  context.state.stageStart(STAGE_NAME);

  try {
    const ticket = context.state.getStageOutput('intake');
    if (!ticket || typeof ticket !== 'object') {
      throw new Error('Plan stage requires intake output (ticket) from stage "intake".');
    }
    const classify = context.state.getStageOutput('classify');
    if (!classify || typeof classify !== 'object') {
      throw new Error('Plan stage requires classify output from stage "classify".');
    }
    const promptTemplate = readFileSync(PLAN_PROMPT_TEMPLATE_PATH, 'utf8');
    let assembledPrompt = renderPlanPrompt(promptTemplate, ticket, classify);

    const contextBlock = assembleContext(context.state, 'plan', 100000);
    if (contextBlock) {
      assembledPrompt += '\n\n## Additional Context\n' + contextBlock;
    }

    const result = await runAgent({
      cli: 'claude',
      prompt: assembledPrompt,
      timeout: TIMEOUTS.plan,
      label: `plan-${ticket?.key || 'unknown'}`,
      metadata: {
        stage: 'plan',
        ticketKey: ticket?.key,
        runId: context.state.runId
      }
    });

    if (context.costTracker) {
      context.costTracker.recordCall('plan', CostTracker.fromAgentResult(result));
    }

    if (!result.success && result.timedOut) {
      throw new Error(`Plan stage timed out after ${result.durationMs}ms`);
    }

    if (!result.success || !result.content) {
      throw new Error('Plan agent did not produce a valid plan \u2014 no <COMPLETED> tag found');
    }

    const planText = result.content.trim();

    const output = {
      plan: planText,
      fullOutput: result.fullOutput,
      sessionId: result.sessionId,
      durationMs: result.durationMs,
      success: result.success
    };

    context.state.checkpoint(STAGE_NAME, output);
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
