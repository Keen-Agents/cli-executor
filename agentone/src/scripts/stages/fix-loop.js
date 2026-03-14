import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runAgent } from '../lib/agent-runner.js';
import { CostTracker } from '../lib/cost-tracker.js';
import { assembleContext } from '../lib/context-assembler.js';
import { TIMEOUTS } from '../pipeline-config.js';
import { runVerificationSuite, isVerificationPassed, requireWorkingDirectory, runVerification } from './verify.js';

const STAGE_NAME = 'fix-loop';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIX_PROMPT_TEMPLATE_PATH = resolve(__dirname, '../prompts/fix.md');

function toText(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function renderTemplate(template, values) {
  let rendered = template;
  for (const [placeholder, value] of Object.entries(values)) {
    rendered = rendered.split(placeholder).join(toText(value));
  }
  return rendered;
}

export async function run(context) {
  context.state.stageStart(STAGE_NAME);

  try {
    const verify = context.state.getStageOutput('verify');
    if (!verify || typeof verify !== 'object') {
      throw new Error('Fix-loop stage requires verify output from stage "verify".');
    }

    if (verify.passed === true) {
      const skipped = {
        fixed: false,
        attempts: [],
        totalAttempts: 0,
        finalVerifyPassed: true,
        effectiveVerify: verify,
        skipped: true,
        reason: 'Verify already passed; fix-loop skipped.'
      };
      context.state.checkpoint(STAGE_NAME, skipped);
      return skipped;
    }

    const implement = context.state.getStageOutput('implement');
    const critiqueOutput = context.state.getStageOutput('cross-critique');
    const plan = context.state.getStageOutput('dual-plan')
              || context.state.getStageOutput('plan');

    const ticketKey = toText(context.ticketKey || implement?.ticketKey || 'UNKNOWN-TICKET').trim() || 'UNKNOWN-TICKET';
    const maxAttempts = Number(context.config?.maxFixAttempts) || 1;
    const cwd = requireWorkingDirectory(context, STAGE_NAME);

    const attempts = [];
    let finalVerifyPassed = false;
    let effectiveVerify = verify;
    let currentTestOutput = toText(verify?.tests?.output);

    // When AGENTONE_SKIP_REVIEW=1, skip Claude fix attempts — return failure details for dispatcher to fix manually
    if (process.env.AGENTONE_SKIP_REVIEW === '1') {
      context.logger?.log({
        type: 'STAGE_INFO',
        stage: STAGE_NAME,
        message: 'Fix-loop skipped (AGENTONE_SKIP_REVIEW=1) — dispatcher will fix failures manually.'
      });
      const output = {
        fixed: false,
        attempts: [],
        totalAttempts: 0,
        finalVerifyPassed: false,
        effectiveVerify: verify,
        skipped: true,
        reason: 'AGENTONE_SKIP_REVIEW=1 — dispatcher will review and fix.',
        failureDetails: {
          testOutput: currentTestOutput,
          summary: toText(verify?.summary),
          lintOutput: toText(verify?.lint?.output || ''),
          auditOutput: toText(verify?.audit?.output || '')
        }
      };
      context.state.checkpoint(STAGE_NAME, output);
      return output;
    }

    const promptTemplate = readFileSync(FIX_PROMPT_TEMPLATE_PATH, 'utf8');

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = Date.now();

      const priorFixes = attempts.length > 0
        ? attempts.map((item) => `Attempt ${item.attempt}: ${item.fixSummary}`).join('\n')
        : '';

      // Use effectiveVerify (latest state) not the initial verify output
      const verifySource = effectiveVerify || verify;
      const verifyNotes = [
        `Verify summary: ${toText(verifySource.summary)}`,
        `Lint passed: ${Boolean(verifySource?.lint?.passed)}`,
        `Lint output: ${toText(verifySource?.lint?.output || '').trim()}`,
        `Audit vulnerabilities: ${JSON.stringify(verifySource?.audit?.vulnerabilities || {})}`,
        `Audit output: ${toText(verifySource?.audit?.output || '').trim()}`,
        `Implement summary: ${toText(implement?.summary || '').trim()}`
      ].join('\n');

      const testFailures = `${currentTestOutput}\n\nVerify notes:\n${verifyNotes}`;

      let assembledPrompt = renderTemplate(promptTemplate, {
        '{{TICKET_KEY}}': ticketKey,
        '{{TEST_FAILURES}}': testFailures,
        '{{PLAN}}': toText(critiqueOutput?.finalPlan || plan?.plan || ''),
        '{{ATTEMPT}}': String(attempt),
        '{{MAX_ATTEMPTS}}': String(maxAttempts),
        '{{PRIOR_FIXES}}': priorFixes
      });

      const contextBlock = assembleContext(context.state, 'fix-loop', 100000, { priorFixAttempts: priorFixes, testFailures: currentTestOutput });
      if (contextBlock) {
        assembledPrompt += '\n\n## Additional Context\n' + contextBlock;
      }

      context.logger?.log({
        type: 'SESSION_SPAWNED',
        stage: STAGE_NAME,
        attempt,
        message: `Starting fix attempt ${attempt}/${maxAttempts}`
      });

      const result = await runAgent({
        cli: 'claude',
        prompt: assembledPrompt,
        cwd,
        timeout: TIMEOUTS['fix-loop'],
        label: `fix-${ticketKey}-attempt-${attempt}`,
        metadata: { stage: STAGE_NAME, ticketKey, attempt, runId: context.state.runId }
      });

      if (context.costTracker) {
        const callData = CostTracker.fromAgentResult(result);
        if (!callData.label) {
          callData.label = `fix-${ticketKey}-attempt-${attempt}`;
        }
        context.costTracker.recordCall(STAGE_NAME, callData);
      }

      if (result.timedOut) {
        context.logger?.log({
          type: 'SESSION_COMPLETED',
          stage: STAGE_NAME,
          attempt,
          sessionId: result.sessionId,
          success: false,
          timedOut: true,
          durationMs: result.durationMs
        });
        attempts.push({
          attempt,
          fixSummary: 'Agent timed out',
          sessionId: toText(result.sessionId),
          durationMs: Date.now() - startedAt,
          verifyResult: { passed: false, summary: 'Fix agent timed out' }
        });
        continue;
      }

      context.logger?.log({
        type: 'SESSION_COMPLETED',
        stage: STAGE_NAME,
        attempt,
        sessionId: result.sessionId,
        success: result.success,
        durationMs: result.durationMs
      });

      const verification = runVerificationSuite(cwd);
      const verifyPassed = isVerificationPassed(verification);
      effectiveVerify = {
        passed: verifyPassed,
        tests: verification.tests,
        lint: verification.lint,
        audit: verification.audit,
        summary: verification.summary,
        durationMs: Date.now() - startedAt,
      };
      const verifySummary = verification.summary || 'Verification failed after fix attempt.';
      const verifyOutput = [
        verification.tests?.output || '',
        verification.tests?.stderr || '',
        verification.lint?.output || '',
        verification.lint?.stderr || '',
        verification.audit?.output || ''
      ].filter(Boolean).join('\n').trim();
      const attemptRecord = {
        attempt,
        fixSummary: toText(result.content || result.fullOutput || '').trim(),
        sessionId: toText(result.sessionId),
        durationMs: Date.now() - startedAt,
        verifyResult: {
          passed: verifyPassed,
          summary: verifySummary
        }
      };

      attempts.push(attemptRecord);

      context.logger?.log({
        type: 'GATE_CHECK',
        stage: STAGE_NAME,
        gate: 'post-fix verification',
        attempt,
        passed: verifyPassed,
        summary: verifySummary
      });

      if (verifyPassed) {
        finalVerifyPassed = true;
        effectiveVerify = runVerification(cwd);
        context.state.checkpoint('verify', effectiveVerify);
        break;
      } else {
        currentTestOutput = verifyOutput || currentTestOutput;
      }
    }

    const output = {
      fixed: finalVerifyPassed,
      attempts,
      totalAttempts: attempts.length,
      finalVerifyPassed,
      effectiveVerify
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
