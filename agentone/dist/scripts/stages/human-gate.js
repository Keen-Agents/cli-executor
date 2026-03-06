import fs from 'node:fs';
import path from 'node:path';
import { TIMEOUTS } from '../pipeline-config.js';

const STAGE_NAME = 'human-gate';
const REQUEST_FILE = 'human-decision-request.json';
const DECISION_FILE = 'human-decision.json';
const POLL_INTERVAL_MS = 10_000;
const VALID_DECISIONS = new Set(['approve', 'revise', 'reject']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toStringOrEmpty(value) {
  return typeof value === 'string' ? value : '';
}

function coerceComments(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function resolvePlan(state) {
  const critique = state.getStageOutput('cross-critique');
  if (critique && typeof critique === 'object' && typeof critique.finalPlan === 'string' && critique.finalPlan.trim()) {
    return critique.finalPlan.trim();
  }

  const plan = state.getStageOutput('dual-plan')
            || state.getStageOutput('plan');
  if (plan && typeof plan === 'object' && typeof plan.plan === 'string') {
    return plan.plan.trim();
  }

  return '';
}

function resolveCritiqueSummary(state) {
  const critique = state.getStageOutput('cross-critique');
  if (!critique || typeof critique !== 'object') {
    return null;
  }

  if (typeof critique.summary === 'string' && critique.summary.trim()) {
    return critique.summary.trim();
  }

  if (Array.isArray(critique.rounds) && critique.rounds.length > 0) {
    const lastRound = critique.rounds[critique.rounds.length - 1];
    if (lastRound && typeof lastRound.critique === 'string' && lastRound.critique.trim()) {
      return lastRound.critique.trim();
    }
  }

  return null;
}

function buildSummary({ ticket, classify, planText, critiqueSummary, verifyResult }) {
  const ticketKey = toStringOrEmpty(ticket?.key);
  const ticketSummary = toStringOrEmpty(ticket?.summary);
  const profile = toStringOrEmpty(classify?.profile);
  const parts = [
    `Ticket: ${ticketKey || 'unknown'}${ticketSummary ? ` - ${ticketSummary}` : ''}`,
    `Profile: ${profile || 'unknown'}`,
    `Plan available: ${planText ? 'yes' : 'no'}`,
    `Critique available: ${critiqueSummary ? 'yes' : 'no'}`,
    `Verification included: ${verifyResult ? 'yes' : 'no'}`,
    'Choose approve to continue, revise to continue with revision comments (Phase 4 loop pending), or reject to stop the pipeline.'
  ];

  return parts.join('\n');
}

function readDecisionFile(decisionPath) {
  if (!fs.existsSync(decisionPath)) {
    return null;
  }

  const raw = fs.readFileSync(decisionPath, 'utf8');
  const parsed = JSON.parse(raw);
  const decision = typeof parsed?.decision === 'string' ? parsed.decision.trim().toLowerCase() : '';
  if (!VALID_DECISIONS.has(decision)) {
    throw new Error('Invalid decision. Expected approve, revise, or reject.');
  }

  return {
    decision,
    comments: coerceComments(parsed?.comments),
  };
}

export async function run(context) {
  const instanceName = context.stageName || STAGE_NAME;
  const requestedAt = new Date().toISOString();
  const maxWaitMs = TIMEOUTS[STAGE_NAME];
  const runId = context.state.runId;
  const runDir = path.resolve(context.runDir || context.state.getRunDir());
  const instanceSuffix = instanceName !== STAGE_NAME ? `-${instanceName.replace(':', '-')}` : '';
  const requestFile = instanceSuffix ? `human-decision-request${instanceSuffix}.json` : REQUEST_FILE;
  const decisionFile = instanceSuffix ? `human-decision${instanceSuffix}.json` : DECISION_FILE;
  const requestPath = path.join(runDir, requestFile);
  const decisionPath = path.join(runDir, decisionFile);

  context.state.stageStart(instanceName);

  try {
    const ticket = context.state.getStageOutput('intake') || null;
    const classify = context.state.getStageOutput('classify') || null;
    const critiqueSummary = resolveCritiqueSummary(context.state);
    const verifyResult = context.state.getStageOutput('verify') || null;
    const planText = resolvePlan(context.state);
    const profile = toStringOrEmpty(classify?.profile) || toStringOrEmpty(context.state?.state?.profile) || 'unknown';

    const requestPayload = {
      requestedAt,
      stage: instanceName,
      runId,
      ticketKey: context.ticketKey,
      profile,
      summary: buildSummary({ ticket, classify, planText, critiqueSummary, verifyResult }),
      plan: planText,
      critique: critiqueSummary,
      verifyResult: verifyResult && typeof verifyResult === 'object' ? verifyResult : null,
      options: ['approve', 'revise', 'reject']
    };

    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(requestPath, `${JSON.stringify(requestPayload, null, 2)}\n`, 'utf8');

    context.state.pause('human_gate', { requestFile: requestFile });
    context.logger?.log({
      type: 'PAUSED_HITL',
      stage: instanceName,
      reason: 'human_gate',
      requestFile: requestFile
    });

    console.log(`[${instanceName}] Pipeline paused for human review.`);
    console.log(`[${instanceName}] Review: logs/pipeline-runs/${runId}/${requestFile}`);
    console.log(`[${instanceName}] To continue, create: logs/pipeline-runs/${runId}/${decisionFile}`);
    console.log(`[${instanceName}] Format: { "decision": "approve|revise|reject", "comments": "..." }`);

    let finalDecision = null;
    while (!finalDecision) {
      const elapsedMs = Date.now() - Date.parse(requestedAt);
      if (elapsedMs >= maxWaitMs) {
        context.state.pause('budget_timeout', {
          stage: instanceName,
          reason: 'budget_timeout',
          waitDurationMs: elapsedMs,
          requestFile: requestFile
        });
        context.logger?.log({
          type: 'PAUSED_HITL',
          stage: instanceName,
          reason: 'budget_timeout',
          waitDurationMs: elapsedMs
        });
        throw new Error(`Timed out waiting for ${decisionFile} after ${elapsedMs}ms`);
      }

      try {
        finalDecision = readDecisionFile(decisionPath);
      } catch (error) {
        console.log(`[${instanceName}] Invalid ${decisionFile}: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (!finalDecision) {
        await sleep(POLL_INTERVAL_MS);
      }
    }

    const decidedAt = new Date().toISOString();
    const waitDurationMs = Date.parse(decidedAt) - Date.parse(requestedAt);
    const output = {
      decision: finalDecision.decision,
      comments: finalDecision.comments,
      waitDurationMs,
      requestedAt,
      decidedAt
    };

    if (output.decision === 'revise') {
      context.logger?.log({
        type: 'GATE_CHECK',
        stage: instanceName,
        gate: 'human_revision_requested',
        comments: output.comments
      });
    }

    context.state.resume(output.decision);
    context.state.checkpoint(instanceName, output);
    context.logger?.log({
      type: 'RESUMED',
      stage: instanceName,
      decision: output.decision
    });

    if (output.decision === 'reject') {
      const reason = output.comments || 'Human rejected the pipeline run.';
      context.state.fail(instanceName, reason);
      throw new Error(reason);
    }

    return output;
  } catch (error) {
    context.logger?.log({
      type: 'STAGE_FAILED',
      stage: instanceName,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}
