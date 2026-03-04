import fs from 'node:fs/promises';

import { TIMEOUTS } from '../pipeline-config.js';
import { runAgent } from '../lib/agent-runner.js';
import { assembleContext } from '../lib/context-assembler.js';
import { CostTracker } from '../lib/cost-tracker.js';

const STAGE_NAME = 'implement';

const TEMPLATE_PATH = new URL('../prompts/implement.md', import.meta.url);

function replaceAll(template, placeholder, value) {
  return template.split(placeholder).join(value);
}

export async function run(context) {
  context.state.stageStart(STAGE_NAME);

  try {
    const ticket = context.state.getStageOutput('intake');
    if (!ticket || typeof ticket !== 'object') {
      throw new Error('Implement stage requires intake output (ticket) from stage "intake".');
    }

    const critiqueOutput = context.state.getStageOutput('cross-critique');
    const plan = context.state.getStageOutput('dual-plan')
              || context.state.getStageOutput('plan');
    if (!plan && !critiqueOutput) {
      throw new Error('Implement stage requires plan output from stage "plan", "dual-plan", or "cross-critique".');
    }

    const ticketKey = String(ticket.key || '').trim();
    const ticketSummary = String(ticket.summary || '').trim();
    const planText = String(critiqueOutput?.finalPlan || plan?.plan || '').trim();
    const classifyOutput = context.state.getStageOutput('classify');
    const profile = String(classifyOutput?.profile || context.state.toJSON()?.profile || '').trim();

    if (!ticketKey) {
      throw new Error('Implement stage requires ticket.key from intake output.');
    }

    if (!ticketSummary) {
      throw new Error('Implement stage requires ticket.summary from intake output.');
    }

    if (!planText) {
      throw new Error('Implement stage requires plan.plan text from plan output.');
    }

    if (!profile) {
      throw new Error('Implement stage requires profile (simple/standard/complex).');
    }

    let template;
    try {
      template = await fs.readFile(TEMPLATE_PATH, 'utf8');
    } catch (error) {
      throw new Error(`Implement prompt template load failed at ${TEMPLATE_PATH.pathname}: ${error instanceof Error ? error.message : String(error)}`);
    }

    let assembledPrompt = template;
    assembledPrompt = replaceAll(assembledPrompt, '{{TICKET_KEY}}', ticketKey);
    assembledPrompt = replaceAll(assembledPrompt, '{{TICKET_SUMMARY}}', ticketSummary);
    assembledPrompt = replaceAll(assembledPrompt, '{{PLAN}}', planText);
    assembledPrompt = replaceAll(assembledPrompt, '{{PROFILE}}', profile);

    const contextBlock = assembleContext(context.state, 'implement', 100000);
    if (contextBlock) {
      assembledPrompt += '\n\n## Additional Context\n' + contextBlock;
    }

    const result = await runAgent({
      cli: 'claude',
      prompt: assembledPrompt,
      cwd: context.workDir || undefined,
      timeout: TIMEOUTS.implement,
      label: `implement-${ticketKey}`,
      metadata: { stage: STAGE_NAME, ticketKey, runId: context.state.runId }
    });

    if (context.costTracker) {
      const callData = CostTracker.fromAgentResult(result);
      if (!callData.label) {
        callData.label = `implement-${ticketKey}`;
      }
      context.costTracker.recordCall(STAGE_NAME, callData);
    }

    if (result.timedOut) {
      throw new Error(`Implement stage timed out after ${TIMEOUTS.implement}ms for ticket ${ticketKey}.`);
    }

    if (!result.content) {
      const partialLen = (result.fullOutput || '').length;
      throw new Error(`Implement stage did not return a <COMPLETED> tag. Partial output length: ${partialLen}.`);
    }

    const output = {
      summary: result.content,
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