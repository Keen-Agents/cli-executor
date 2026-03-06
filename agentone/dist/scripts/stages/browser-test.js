import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runAgent } from '../lib/agent-runner.js';
import { CostTracker } from '../lib/cost-tracker.js';
import { assembleContext } from '../lib/context-assembler.js';
import { TIMEOUTS, BRIDGE_URL } from '../pipeline-config.js';

const STAGE_NAME = 'browser-test';
const COMPLETED_REGEX = /<COMPLETED>([\s\S]*?)<\/COMPLETED>/;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPT_PATH = resolve(__dirname, '../prompts/browser-test.md');

function asText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

function fillTemplate(template, replacements) {
  let output = template;
  for (const [key, value] of Object.entries(replacements)) {
    output = output.split(key).join(asText(value));
  }
  return output;
}

function resolvePlan(state) {
  const critique = state.getStageOutput('cross-critique');
  if (critique?.finalPlan) return critique.finalPlan;
  const plan = state.getStageOutput('dual-plan') || state.getStageOutput('plan');
  return asText(plan?.plan);
}

function detectAppUrl(implementOutput) {
  const combined = asText(implementOutput?.summary) + '\n' + asText(implementOutput?.fullOutput);
  const match = combined.match(/https?:\/\/localhost:\d+/);
  return match ? match[0] : 'http://localhost:3000';
}

export async function run(context) {
  context.state.stageStart(STAGE_NAME);
  context.logger?.log({ type: 'STAGE_STARTED', stage: STAGE_NAME });

  try {
    const ticket = context.state.getStageOutput('intake');
    if (!ticket || typeof ticket !== 'object') {
      throw new Error('Browser-test stage requires intake output.');
    }

    const implementOutput = context.state.getStageOutput('implement');
    if (!implementOutput || typeof implementOutput !== 'object') {
      throw new Error('Browser-test stage requires implement output.');
    }

    const verifyOutput = context.state.getStageOutput('verify');
    const planText = resolvePlan(context.state);
    const ticketKey = asText(ticket.key);
    const ticketSummary = asText(ticket.summary);
    const implementSummary = asText(implementOutput.summary);
    const verifySummary = asText(verifyOutput?.summary);
    const appUrl = detectAppUrl(implementOutput);
    const workDir = implementOutput.workingDirectory || context.workDir;
    const bridgeUrl = BRIDGE_URL || 'http://localhost:3222';

    const template = readFileSync(PROMPT_PATH, 'utf8');
    let prompt = fillTemplate(template, {
      '{{TICKET_KEY}}': ticketKey,
      '{{TICKET_SUMMARY}}': ticketSummary,
      '{{PLAN}}': planText,
      '{{IMPLEMENT_SUMMARY}}': implementSummary,
      '{{VERIFY_SUMMARY}}': verifySummary,
      '{{APP_URL}}': appUrl,
      '{{BRIDGE_URL}}': bridgeUrl
    });

    const contextBlock = assembleContext(context.state, STAGE_NAME, 80000);
    if (contextBlock) {
      prompt += '\n\n## Additional Context\n' + contextBlock;
    }

    const result = await runAgent({
      cli: 'claude',
      prompt,
      cwd: workDir || undefined,
      timeout: TIMEOUTS[STAGE_NAME] || 600_000,
      label: `browser-test-${ticketKey || 'unknown'}`,
      metadata: {
        stage: STAGE_NAME,
        ticketKey,
        runId: context.state.runId
      },
      extractRegex: COMPLETED_REGEX
    });

    if (context.costTracker) {
      context.costTracker.recordCall(STAGE_NAME, CostTracker.fromAgentResult(result));
    }

    if (result.timedOut) {
      throw new Error(`Browser-test stage timed out after ${result.durationMs}ms.`);
    }

    if (!result.content) {
      throw new Error('Browser-test stage did not return a <COMPLETED> tag.');
    }

    const contentLower = result.content.toLowerCase();
    const passed = contentLower.includes('pass') && !contentLower.includes('fail');

    const output = {
      passed,
      summary: result.content.trim(),
      fullOutput: result.fullOutput,
      sessionId: result.sessionId || null,
      durationMs: result.durationMs,
      success: result.success
    };

    context.state.checkpoint(STAGE_NAME, output);
    context.logger?.log({
      type: 'STAGE_COMPLETED',
      stage: STAGE_NAME,
      passed
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
