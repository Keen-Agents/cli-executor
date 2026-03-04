import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runAgent } from '../lib/agent-runner.js';
import { CostTracker } from '../lib/cost-tracker.js';
import { TIMEOUTS } from '../pipeline-config.js';

const STAGE_NAME = 'cross-critique';
const COMPLETED_REGEX = /<COMPLETED>([\s\S]*?)<\/COMPLETED>/;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CRITIQUE_PROMPT_TEMPLATE_PATH = resolve(__dirname, '../prompts/critique.md');

function asText(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function fillTemplate(template, replacements) {
  let output = template;
  for (const [key, value] of Object.entries(replacements)) {
    output = output.split(key).join(asText(value));
  }
  return output;
}

function buildRevisionPrompt({ ticket, currentPlan, critique, round, maxRounds }) {
  return [
    'You are the original planner revising an implementation plan based on critique.',
    '',
    `Ticket: ${asText(ticket?.key)}`,
    `Summary: ${asText(ticket?.summary)}`,
    `Revision Round: ${round} of ${maxRounds}`,
    '',
    'Current Plan:',
    currentPlan,
    '',
    'Critique To Address:',
    critique,
    '',
    'Revise the plan to address the critique while keeping it practical and complete.',
    'If the critique is already addressed, keep the plan unchanged and state that briefly inside the plan.',
    '',
    'Return only the revised plan wrapped in tags:',
    '<COMPLETED>',
    '[Revised plan]',
    '</COMPLETED>'
  ].join('\n');
}

export async function run(context) {
  context.state.stageStart(STAGE_NAME);
  context.logger?.log({ type: 'STAGE_STARTED', stage: STAGE_NAME });

  try {
    const planOutput = context.state.getStageOutput('plan');
    if (!planOutput || typeof planOutput !== 'object') {
      throw new Error('Cross-critique stage requires plan output from stage "plan".');
    }

    const intakeOutput = context.state.getStageOutput('intake');
    if (!intakeOutput || typeof intakeOutput !== 'object') {
      throw new Error('Cross-critique stage requires intake output from stage "intake".');
    }

    const classifyOutput = context.state.getStageOutput('classify');
    if (!classifyOutput || typeof classifyOutput !== 'object') {
      throw new Error('Cross-critique stage requires classify output from stage "classify".');
    }

    const maxRounds = Number(context?.config?.maxConvergenceRounds ?? 0);
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

    const critiqueTemplate = readFileSync(CRITIQUE_PROMPT_TEMPLATE_PATH, 'utf8');
    const rounds = [];
    let currentPlan = initialPlan;
    let priorCritique = '';
    let converged = false;

    for (let round = 1; round <= maxRounds; round += 1) {
      const critiquePrompt = fillTemplate(critiqueTemplate, {
        '{{TICKET_KEY}}': asText(intakeOutput.key),
        '{{TICKET_SUMMARY}}': asText(intakeOutput.summary),
        '{{PLAN}}': currentPlan,
        '{{ROUND}}': String(round),
        '{{MAX_ROUNDS}}': String(maxRounds),
        '{{PRIOR_CRITIQUE}}': priorCritique
      });

      const critiqueResult = await runAgent({
        cli: 'claude',
        prompt: critiquePrompt,
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
        extractRegex: COMPLETED_REGEX
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
      let revisedPlan = '';
      let revisionSessionId = null;
      let revisionDurationMs = null;

      const shouldRevise = maxRounds > 1;
      if (shouldRevise) {
        const revisionPrompt = buildRevisionPrompt({
          ticket: intakeOutput,
          currentPlan,
          critique: critiqueText,
          round,
          maxRounds
        });

        const revisionResult = await runAgent({
          cli: 'claude',
          prompt: revisionPrompt,
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
          extractRegex: COMPLETED_REGEX
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

        if (revisedPlan === currentPlan) {
          converged = true;
        }
        currentPlan = revisedPlan || currentPlan;
      }

      rounds.push({
        round,
        critique: critiqueText,
        revisedPlan,
        critiqueSessionId: critiqueResult.sessionId || '',
        revisionSessionId,
        critiqueDurationMs: critiqueResult.durationMs,
        revisionDurationMs
      });

      priorCritique = critiqueText;
      if (converged) {
        break;
      }
    }

    const output = {
      rounds,
      finalPlan: currentPlan,
      totalRounds: rounds.length,
      converged
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
