import { execFileSync } from 'node:child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runAgent } from '../lib/agent-runner.js';
import { CostTracker } from '../lib/cost-tracker.js';
import { TIMEOUTS } from '../pipeline-config.js';

const STAGE_NAME = 'security-audit';
const COMPLETED_REGEX = /<COMPLETED>([\s\S]*?)<\/COMPLETED>/;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPT_PATH = resolve(__dirname, '../prompts/security-audit.md');

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

/**
 * Collect the git diff of changes made by the implement stage.
 */
function collectDiff(workDir) {
  if (!workDir) return '(no working directory available)';
  try {
    const diff = execFileSync('git', ['diff', 'HEAD~1', '--no-color'], {
      cwd: workDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000
    });
    // Cap at 80KB to stay within context limits
    return diff.length > 80_000
      ? diff.slice(0, 80_000) + '\n\n... (diff truncated at 80KB)'
      : diff;
  } catch {
    return '(unable to collect git diff)';
  }
}

/**
 * Run npm audit and return a summary.
 */
function collectDepAudit(workDir) {
  if (!workDir) return '(no working directory)';
  try {
    const raw = execFileSync('npm', ['audit', '--json'], {
      cwd: workDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000
    });
    const parsed = JSON.parse(raw);
    const vuln = parsed?.metadata?.vulnerabilities || {};
    const lines = [
      `Total: ${parsed?.metadata?.totalDependencies || '?'} dependencies`,
      `Critical: ${vuln.critical || 0}`,
      `High: ${vuln.high || 0}`,
      `Moderate: ${vuln.moderate || 0}`,
      `Low: ${vuln.low || 0}`,
      `Info: ${vuln.info || 0}`
    ];
    return lines.join('\n');
  } catch (err) {
    // npm audit exits non-zero when vulnerabilities are found
    const stdout = typeof err?.stdout === 'string' ? err.stdout : '';
    try {
      const parsed = JSON.parse(stdout);
      const vuln = parsed?.metadata?.vulnerabilities || {};
      return [
        `Total: ${parsed?.metadata?.totalDependencies || '?'} dependencies`,
        `Critical: ${vuln.critical || 0}`,
        `High: ${vuln.high || 0}`,
        `Moderate: ${vuln.moderate || 0}`,
        `Low: ${vuln.low || 0}`
      ].join('\n');
    } catch {
      return '(npm audit not available or failed)';
    }
  }
}

export async function run(context) {
  context.state.stageStart(STAGE_NAME);
  context.logger?.log({ type: 'STAGE_STARTED', stage: STAGE_NAME });

  try {
    const ticket = context.state.getStageOutput('intake');
    if (!ticket || typeof ticket !== 'object') {
      throw new Error('Security-audit stage requires intake output.');
    }

    const implementOutput = context.state.getStageOutput('implement');
    const workDir = implementOutput?.workingDirectory || context.workDir;

    const ticketKey = asText(ticket.key);
    const ticketSummary = asText(ticket.summary);
    const planText = resolvePlan(context.state);
    const codeDiff = collectDiff(workDir);
    const depAudit = collectDepAudit(workDir);

    const template = readFileSync(PROMPT_PATH, 'utf8');
    const prompt = fillTemplate(template, {
      '{{TICKET_KEY}}': ticketKey,
      '{{TICKET_SUMMARY}}': ticketSummary,
      '{{PLAN}}': planText,
      '{{CODE_DIFF}}': codeDiff,
      '{{DEP_AUDIT}}': depAudit
    });

    const result = await runAgent({
      cli: 'claude',
      prompt,
      cwd: workDir || undefined,
      timeout: TIMEOUTS[STAGE_NAME] || 300_000,
      label: `security-audit-${ticketKey || 'unknown'}`,
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
      throw new Error(`Security-audit timed out after ${result.durationMs}ms.`);
    }

    if (!result.content) {
      throw new Error('Security-audit did not return a <COMPLETED> tag.');
    }

    const auditText = result.content.trim();

    // Detect critical/high findings — look for severity markers in formatted output
    // Pattern matches lines like "- **CRITICAL**: ...", "### CRITICAL", "Severity: CRITICAL"
    const criticalFindings = (auditText.match(/(?:^|\n)\s*[-*•#]+\s*\**CRITICAL\**/gi) || []).length
      + (auditText.match(/severity:\s*CRITICAL/gi) || []).length;
    const highFindings = (auditText.match(/(?:^|\n)\s*[-*•#]+\s*\**HIGH\**/gi) || []).length
      + (auditText.match(/severity:\s*HIGH/gi) || []).length;
    const passed = criticalFindings === 0 && highFindings === 0;

    const output = {
      report: auditText,
      passed,
      criticalFindings,
      highFindings,
      sessionId: result.sessionId || null,
      durationMs: result.durationMs,
      depAudit
    };

    context.state.checkpoint(STAGE_NAME, output);
    context.logger?.log({
      type: 'STAGE_COMPLETED',
      stage: STAGE_NAME,
      passed: output.passed,
      criticalFindings: output.criticalFindings,
      highFindings: output.highFindings
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
