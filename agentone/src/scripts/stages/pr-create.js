import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import path from 'node:path';

const STAGE_NAME = 'pr-create';

function quoteArg(value) {
  return `"${String(value).replace(/(["\\$`])/g, '\\$1')}"`;
}

function runCommand(command, cwd, errorPrefix) {
  try {
    return execSync(command, { cwd, encoding: 'utf8' });
  } catch (error) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : '';
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    const details = [stdout, stderr].filter(Boolean).join('\n');
    if (errorPrefix) {
      throw new Error(details ? `${errorPrefix}\n${details}` : errorPrefix);
    }
    throw error;
  }
}

function toText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

function vulnerabilitiesSummary(audit) {
  const vuln = audit?.vulnerabilities || {};
  const critical = Number(vuln.critical || 0);
  const high = Number(vuln.high || 0);
  const moderate = Number(vuln.moderate || 0);
  const low = Number(vuln.low || 0);
  const info = Number(vuln.info || 0);
  const total = critical + high + moderate + low + info;
  return `${total} total (critical: ${critical}, high: ${high}, moderate: ${moderate}, low: ${low}, info: ${info})`;
}

function buildPrBody(ticket, plan, implementSummary, verifyResult, pipelineMeta) {
  const ticketKey = toText(ticket?.key).trim();
  const summary = toText(ticket?.summary).trim() || 'No summary';
  const jiraBase = toText(process.env.JIRA_BASE_URL).replace(/\/+$/, '');
  const jiraUrl = jiraBase && ticketKey ? `${jiraBase}/browse/${ticketKey}` : '';
  const ticketLine = jiraUrl ? `[${ticketKey}](${jiraUrl}) - ${summary}` : `${ticketKey} - ${summary}`;

  const testsStatus = verifyResult?.tests?.passed === true ? 'passed' : verifyResult?.tests?.passed === false ? 'failed' : 'skipped';
  let lintStatus = 'skipped';
  if (verifyResult?.lint?.passed === true) lintStatus = 'passed';
  if (verifyResult?.lint?.passed === false) lintStatus = 'failed';
  const auditStatus = vulnerabilitiesSummary(verifyResult?.audit);

  const totalCost = Number(pipelineMeta.totalCost || 0);

  return [
    '## Ticket',
    ticketLine,
    '',
    '## Changes',
    toText(implementSummary).trim() || toText(plan?.plan).trim() || 'No implementation summary available.',
    '',
    '## Verification',
    `- Tests: ${testsStatus}`,
    `- Lint: ${lintStatus}`,
    `- Audit: ${auditStatus}`,
    '',
    '## Pipeline',
    `- Run ID: ${pipelineMeta.runId}`,
    `- Profile: ${pipelineMeta.profile}`,
    `- Total cost: $${totalCost}`,
    '',
    '---',
    '*Automated PR by AgentOne pipeline*',
  ].join('\n');
}

function parsePrInfo(prListJson) {
  let parsed = [];
  try {
    parsed = JSON.parse(prListJson || '[]');
  } catch {
    parsed = [];
  }
  const existing = Array.isArray(parsed) && parsed.length > 0 ? parsed[0] : null;
  if (!existing) return { prUrl: null, prNumber: null };
  return {
    prUrl: typeof existing.url === 'string' ? existing.url : null,
    prNumber: typeof existing.number === 'number' ? existing.number : null,
  };
}

function parsePrUrl(output) {
  const text = toText(output);
  const match = text.match(/https?:\/\/\S+/);
  return match ? match[0] : null;
}

function readProfile(context) {
  const classify = context.state.getStageOutput('classify');
  const fromClassify = toText(classify?.profile).trim();
  if (fromClassify) return fromClassify;
  const fromState = toText(context.state.toJSON?.()?.profile).trim();
  return fromState || 'unknown';
}

export async function run(context) {
  const cwd = context.workDir || process.cwd();
  const runId = toText(context.state?.runId || context.runId || 'unknown-run').trim();

  context.state.stageStart(STAGE_NAME);
  context.logger?.log({
    type: 'STAGE_STARTED',
    stage: STAGE_NAME,
  });

  try {
    const ticket = context.state.getStageOutput('intake');
    if (!ticket || typeof ticket !== 'object') {
      throw new Error('PR create stage requires intake output from stage "intake".');
    }

    const plan = context.state.getStageOutput('plan') || {};
    const implement = context.state.getStageOutput('implement') || {};
    const verifyResult = context.state.getStageOutput('verify') || null;
    const ticketKey = toText(ticket.key).trim();

    if (!ticketKey) {
      throw new Error('PR create stage requires ticket.key from intake output.');
    }

    const branchName = `pipeline/${runId}/${ticketKey}`;
    const branchArg = quoteArg(branchName);

    try {
      execSync('gh --version', { cwd, encoding: 'utf8' });
    } catch {
      throw new Error('GitHub CLI (gh) is required for PR creation but was not found in PATH.');
    }

    const existingPrRaw = runCommand(
      `gh pr list --head ${branchArg} --json number,url`,
      cwd,
      'Failed to query existing GitHub PRs via gh CLI.'
    );
    const existingPr = parsePrInfo(existingPrRaw);
    if (existingPr.prUrl) {
      const existingSha = runCommand('git rev-parse HEAD', cwd).trim();
      const output = {
        prUrl: existingPr.prUrl,
        prNumber: existingPr.prNumber,
        branch: branchName,
        commitSha: existingSha,
        skipped: false,
        reason: null,
      };
      context.state.checkpoint(STAGE_NAME, output);
      context.logger?.log({
        type: 'STAGE_COMPLETED',
        stage: STAGE_NAME,
        branch: branchName,
        prUrl: existingPr.prUrl,
        reused: true,
      });
      return output;
    }

    const status = runCommand('git status --porcelain', cwd).trim();
    if (!status) {
      const output = {
        prUrl: null,
        prNumber: null,
        branch: branchName,
        commitSha: runCommand('git rev-parse HEAD', cwd).trim(),
        skipped: true,
        reason: 'No changes detected',
      };
      context.state.checkpoint(STAGE_NAME, output);
      context.logger?.log({
        type: 'STAGE_COMPLETED',
        stage: STAGE_NAME,
        skipped: true,
        reason: output.reason,
      });
      return output;
    }

    const existingBranch = runCommand(`git branch --list ${branchArg}`, cwd).trim();
    if (existingBranch) {
      runCommand(`git checkout ${branchArg}`, cwd, `Failed to checkout existing branch "${branchName}".`);
    } else {
      runCommand(`git checkout -b ${branchArg}`, cwd, `Failed to create branch "${branchName}".`);
    }

    runCommand('git add -A', cwd, 'Failed to stage changes with git add -A.');

    const profile = readProfile(context);
    const commitMessage = `${ticketKey}: ${toText(ticket.summary).trim()}\n\nAutomated implementation by AgentOne pipeline.\nRun: ${runId}\nProfile: ${profile}`;
    const commitMessagePath = path.join(cwd, `.agentone-commit-${runId}.txt`);
    writeFileSync(commitMessagePath, commitMessage, 'utf8');
    try {
      runCommand(`git commit -F ${quoteArg(commitMessagePath)}`, cwd, 'Failed to commit changes.');
    } finally {
      try {
        unlinkSync(commitMessagePath);
      } catch {
        // Ignore cleanup failures
      }
    }

    try {
      runCommand(`git push -u origin ${branchArg}`, cwd);
    } catch (error) {
      throw new Error(
        `Failed to push branch "${branchName}" to origin. Ensure git remote "origin" exists and authentication is configured.\n${error instanceof Error ? error.message : String(error)}`
      );
    }

    const prTitle = `${ticketKey}: ${toText(ticket.summary).trim()}`;
    const prBody = buildPrBody(ticket, plan, implement.summary, verifyResult, {
      runId,
      profile,
      totalCost: context.costTracker?.getRunCost?.() || 0,
    });
    const prBodyPath = path.join(cwd, `.agentone-pr-body-${runId}.md`);
    writeFileSync(prBodyPath, prBody, 'utf8');

    let prResult = '';
    try {
      prResult = runCommand(
        `gh pr create --title ${quoteArg(prTitle)} --body-file ${quoteArg(prBodyPath)}`,
        cwd,
        'Failed to create GitHub PR using gh CLI.'
      );
    } finally {
      try {
        unlinkSync(prBodyPath);
      } catch {
        // Ignore cleanup failures
      }
    }

    const prUrl = parsePrUrl(prResult);
    const prNumberMatch = prUrl ? prUrl.match(/\/pull\/(\d+)(?:\D|$)/) : null;
    const prNumber = prNumberMatch ? Number(prNumberMatch[1]) : null;
    const commitSha = runCommand('git rev-parse HEAD', cwd).trim();

    const output = {
      prUrl,
      prNumber,
      branch: branchName,
      commitSha,
      skipped: false,
      reason: null,
    };

    context.state.checkpoint(STAGE_NAME, output);
    context.logger?.log({
      type: 'STAGE_COMPLETED',
      stage: STAGE_NAME,
      branch: branchName,
      commitSha,
      prUrl,
    });

    return output;
  } catch (error) {
    context.logger?.log({
      type: 'STAGE_FAILED',
      stage: STAGE_NAME,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
