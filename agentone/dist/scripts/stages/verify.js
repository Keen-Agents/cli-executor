import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { runAgent } from '../lib/agent-runner.js';
import { CostTracker } from '../lib/cost-tracker.js';
import { TIMEOUTS } from '../pipeline-config.js';

const STAGE_NAME = 'verify';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const VERIFY_PROMPT_PATH = resolve(__dirname, '../prompts/verify.md');

export function requireWorkingDirectory(context, stageName = STAGE_NAME) {
  const cwd = typeof context?.workDir === 'string' ? context.workDir.trim() : '';
  if (!cwd) {
    throw new Error(`${stageName} requires a working directory from intake or pipeline input.`);
  }

  if (!existsSync(cwd)) {
    throw new Error(`${stageName} working directory does not exist: ${cwd}`);
  }

  if (!existsSync(path.join(cwd, '.git'))) {
    throw new Error(`${stageName} working directory is not a git repository: ${cwd}`);
  }

  return cwd;
}

function readPackageJson(cwd) {
  const packageJsonPath = path.join(cwd, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return null;
  }
}

function hasScript(cwd, scriptName) {
  const pkg = readPackageJson(cwd);
  return Boolean(pkg && pkg.scripts && typeof pkg.scripts[scriptName] === 'string' && pkg.scripts[scriptName].trim());
}

function runTests(cwd) {
  const packageJsonPath = path.join(cwd, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return {
      passed: true,
      output: 'No package.json found; skipping npm test.',
    };
  }

  try {
    const stdout = execSync('npm test', { cwd, encoding: 'utf8', timeout: 120_000 });
    return { passed: true, output: stdout };
  } catch (err) {
    const stdout = typeof err?.stdout === 'string' ? err.stdout : '';
    const stderr = typeof err?.stderr === 'string' ? err.stderr : '';
    const combined = `${stdout}\n${stderr}`;

    if (/no test specified/i.test(combined)) {
      return {
        passed: true,
        output: combined.trim() || 'No test script specified; treating as passed.',
      };
    }

    return {
      passed: false,
      output: combined.trim(),
      stderr,
      exitCode: typeof err?.status === 'number' ? err.status : null,
    };
  }
}

function runLint(cwd) {
  if (!existsSync(path.join(cwd, 'package.json'))) {
    return null;
  }

  if (!hasScript(cwd, 'lint')) {
    return null;
  }

  try {
    const stdout = execSync('npm run lint', { cwd, encoding: 'utf8', timeout: 120_000 });
    return { passed: true, output: stdout };
  } catch (err) {
    return {
      passed: false,
      output: typeof err?.stdout === 'string' ? err.stdout : '',
      stderr: typeof err?.stderr === 'string' ? err.stderr : '',
      exitCode: typeof err?.status === 'number' ? err.status : null,
    };
  }
}

function runAudit(cwd) {
  if (!existsSync(path.join(cwd, 'package.json'))) {
    return {
      vulnerabilities: {},
      output: 'No package.json found; skipping npm audit.',
    };
  }

  try {
    const stdout = execSync('npm audit --json', { cwd, encoding: 'utf8', timeout: 60_000 });
    const audit = JSON.parse(stdout);
    return { vulnerabilities: audit.metadata?.vulnerabilities || {}, output: stdout };
  } catch (err) {
    const stdout = typeof err?.stdout === 'string' ? err.stdout : '';

    try {
      const audit = JSON.parse(stdout || '{}');
      return { vulnerabilities: audit.metadata?.vulnerabilities || {}, output: stdout };
    } catch {
      return { vulnerabilities: {}, output: stdout, error: 'Failed to parse audit output' };
    }
  }
}

function buildSummary({ tests, lint, audit }) {
  const parts = [];

  parts.push(tests.passed ? 'Tests: passed' : 'Tests: failed');

  if (lint === null) {
    parts.push('Lint: skipped');
  } else {
    parts.push(lint.passed ? 'Lint: passed' : 'Lint: failed');
  }

  const totalVulns = ['critical', 'high', 'moderate', 'low', 'info']
    .map((key) => Number(audit?.vulnerabilities?.[key] || 0))
    .reduce((sum, count) => sum + count, 0);

  parts.push(`Audit vulnerabilities: ${totalVulns}`);

  return parts.join(' | ');
}

function auditPasses(audit) {
  const vulnerabilities = audit?.vulnerabilities || {};
  const critical = Number(vulnerabilities.critical || 0);
  const high = Number(vulnerabilities.high || 0);
  return critical === 0 && high === 0;
}

export function isVerificationPassed(result) {
  const lintPassed = result?.lint === null || result?.lint?.passed === true;
  // Fail closed: require audit.passed === true (not just !== false)
  const auditPassed = result?.audit?.passed === true;
  return result?.tests?.passed === true && lintPassed && auditPassed;
}

export function runVerificationSuite(cwd) {
  const tests = runTests(cwd);
  const lint = runLint(cwd);
  const audit = runAudit(cwd);
  const auditPassed = auditPasses(audit);

  return {
    tests: {
      passed: tests.passed,
      output: tests.output || '',
      stderr: tests.stderr || '',
      exitCode: tests.exitCode ?? null,
    },
    lint: lint
      ? {
          passed: lint.passed,
          output: lint.output || '',
          stderr: lint.stderr || '',
          exitCode: lint.exitCode ?? null,
        }
      : null,
    audit: {
      passed: auditPassed,
      vulnerabilities: audit.vulnerabilities || {},
      output: audit.output || '',
    },
    summary: buildSummary({ tests, lint, audit }),
  };
}

export function runVerification(cwd, startedAt = Date.now()) {
  const suite = runVerificationSuite(cwd);
  return {
    passed: isVerificationPassed(suite),
    tests: suite.tests,
    lint: suite.lint,
    audit: suite.audit,
    summary: suite.summary,
    durationMs: Date.now() - startedAt,
  };
}

export async function run(context) {
  const startedAt = Date.now();
  const cwd = requireWorkingDirectory(context);

  context.state.stageStart(STAGE_NAME);
  context.logger?.log({
    type: 'STAGE_STARTED',
    stage: STAGE_NAME,
    message: 'Running local verification checks',
  });

  try {
    const implementOutput = context.state.getStageOutput('implement');

    const result = runVerification(cwd, startedAt);
    const tests = result.tests;
    context.logger?.log({
      type: 'GATE_CHECK',
      stage: STAGE_NAME,
      gate: 'npm test',
      passed: tests.passed,
    });

    const lint = result.lint;
    if (lint !== null) {
      context.logger?.log({
        type: 'GATE_CHECK',
        stage: STAGE_NAME,
        gate: 'npm run lint',
        passed: lint.passed,
      });
    }

    const audit = result.audit;
    context.logger?.log({
      type: 'GATE_CHECK',
      stage: STAGE_NAME,
      gate: 'npm audit --json',
      vulnerabilities: audit.vulnerabilities,
      passed: audit.passed,
    });

    if (!implementOutput) {
      result.summary = `${result.summary} | Note: implement output not found.`;
    }

    // Optional AI code review for non-simple profiles (advisory only)
    result.aiReview = null;
    const profile = context.state?.toJSON?.()?.profile;
    if (result.passed && profile && profile !== 'simple') {
      try {
        let codeDiff = '';
        try {
          codeDiff = execSync('git diff HEAD~1', { cwd, encoding: 'utf8', timeout: 30_000 });
        } catch { /* no diff available */ }

        if (codeDiff.trim()) {
          const intake = context.state.getStageOutput('intake') || {};
          const plan = context.state.getStageOutput('cross-critique')?.finalPlan
                    || context.state.getStageOutput('dual-plan')?.plan
                    || context.state.getStageOutput('plan')?.plan || '';

          const template = readFileSync(VERIFY_PROMPT_PATH, 'utf8');
          const prompt = template
            .split('{{TICKET_KEY}}').join(intake.key || context.ticketKey || '')
            .split('{{TICKET_SUMMARY}}').join(intake.summary || '')
            .split('{{PLAN}}').join(plan)
            .split('{{CODE_DIFF}}').join(codeDiff.slice(0, 80_000))
            .split('{{TEST_OUTPUT}}').join((result.tests?.output || '').slice(0, 10_000));

          const aiResult = await runAgent({
            cli: 'claude',
            prompt,
            cwd,
            timeout: TIMEOUTS.verify,
            label: `verify-ai-review-${intake.key || context.ticketKey || 'unknown'}`,
            metadata: { stage: STAGE_NAME, mode: 'ai-review', runId: context.state.runId }
          });

          if (context.costTracker) {
            context.costTracker.recordCall(STAGE_NAME, CostTracker.fromAgentResult(aiResult));
          }

          result.aiReview = {
            content: aiResult.content || aiResult.fullOutput || '',
            sessionId: aiResult.sessionId,
            durationMs: aiResult.durationMs,
            success: aiResult.success
          };

          context.logger?.log({
            type: 'GATE_CHECK',
            stage: STAGE_NAME,
            gate: 'ai-code-review',
            success: aiResult.success,
            durationMs: aiResult.durationMs
          });
        }
      } catch (aiErr) {
        context.logger?.log({
          type: 'GATE_CHECK',
          stage: STAGE_NAME,
          gate: 'ai-code-review',
          success: false,
          error: aiErr instanceof Error ? aiErr.message : String(aiErr)
        });
      }
    }

    context.state.checkpoint(STAGE_NAME, result);
    context.logger?.log({
      type: 'STAGE_COMPLETED',
      stage: STAGE_NAME,
      passed: result.passed,
      durationMs: result.durationMs,
    });

    return result;
  } catch (error) {
    const failed = {
      passed: false,
      tests: { passed: false, output: '', stderr: '', exitCode: null },
      lint: null,
      audit: { passed: false, vulnerabilities: {}, output: '' },
      summary: `Verification stage failed: ${error instanceof Error ? error.message : String(error)}`,
      durationMs: Date.now() - startedAt,
    };

    context.state.checkpoint(STAGE_NAME, failed);
    context.logger?.log({
      type: 'STAGE_FAILED',
      stage: STAGE_NAME,
      error: error instanceof Error ? error.message : String(error),
    });

    return failed;
  }
}
