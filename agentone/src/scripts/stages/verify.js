import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

const STAGE_NAME = 'verify';

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
      output: stdout,
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

export async function run(context) {
  const startedAt = Date.now();
  const cwd = context.workDir || process.cwd();

  context.state.stageStart(STAGE_NAME);
  context.logger?.log({
    type: 'STAGE_STARTED',
    stage: STAGE_NAME,
    message: 'Running local verification checks',
  });

  try {
    const implementOutput = context.state.getStageOutput('implement');

    const tests = runTests(cwd);
    context.logger?.log({
      type: 'GATE_CHECK',
      stage: STAGE_NAME,
      gate: 'npm test',
      passed: tests.passed,
    });

    const lint = runLint(cwd);
    if (lint !== null) {
      context.logger?.log({
        type: 'GATE_CHECK',
        stage: STAGE_NAME,
        gate: 'npm run lint',
        passed: lint.passed,
      });
    }

    const audit = runAudit(cwd);
    context.logger?.log({
      type: 'GATE_CHECK',
      stage: STAGE_NAME,
      gate: 'npm audit --json',
      vulnerabilities: audit.vulnerabilities,
    });

    const result = {
      passed: tests.passed,
      tests: {
        passed: tests.passed,
        output: tests.output || '',
      },
      lint: lint
        ? {
            passed: lint.passed,
            output: lint.output || '',
          }
        : null,
      audit: {
        vulnerabilities: audit.vulnerabilities || {},
        output: audit.output || '',
      },
      summary: buildSummary({ tests, lint, audit }),
      durationMs: Date.now() - startedAt,
    };

    if (!implementOutput) {
      result.summary = `${result.summary} | Note: implement output not found.`;
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
      tests: { passed: false, output: '' },
      lint: null,
      audit: { vulnerabilities: {}, output: '' },
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
