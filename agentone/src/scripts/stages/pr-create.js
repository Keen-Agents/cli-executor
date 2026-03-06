import { execFileSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import path from 'node:path';
import { executeSideEffect, getSideEffects, writeCompensationFile } from '../lib/side-effects.js';

const STAGE_NAME = 'pr-create';

function runCommand(command, args, cwd, errorPrefix) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
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

function sanitizeRefSegment(value, fallback) {
  const sanitized = toText(value)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || fallback;
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

function requireWorkingDirectory(context) {
  const cwd = typeof context.workDir === 'string' ? context.workDir.trim() : '';
  if (!cwd) {
    throw new Error('PR create stage requires a working directory from intake or pipeline input.');
  }
  return cwd;
}

export async function run(context) {
  const cwd = requireWorkingDirectory(context);
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

    const plan = context.state.getStageOutput('dual-plan')
              || context.state.getStageOutput('plan') || {};
    const implement = context.state.getStageOutput('implement') || {};
    const fixLoopOutput = context.state.getStageOutput('fix-loop') || null;
    const verifyResult = fixLoopOutput?.effectiveVerify || context.state.getStageOutput('verify') || null;
    const ticketKey = toText(ticket.key).trim();

    if (!ticketKey) {
      throw new Error('PR create stage requires ticket.key from intake output.');
    }

    const branchName = toText(context.state.getMetadata?.('worktreeBranch')).trim()
      || `pipeline/${sanitizeRefSegment(runId, 'run')}/${sanitizeRefSegment(ticketKey, 'ticket')}`;
    const currentBranch = runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, 'Failed to resolve current git branch.').trim();

    try {
      execFileSync('gh', ['--version'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      throw new Error('GitHub CLI (gh) is required for PR creation but was not found in PATH.');
    }

    const existingPrRaw = runCommand(
      'gh',
      ['pr', 'list', '--head', branchName, '--json', 'number,url'],
      cwd,
      'Failed to query existing GitHub PRs via gh CLI.'
    );
    const existingPr = parsePrInfo(existingPrRaw);
    if (existingPr.prUrl) {
      const existingSha = runCommand('git', ['rev-parse', 'HEAD'], cwd, 'Failed to resolve current commit SHA.').trim();
      const output = {
        prUrl: existingPr.prUrl,
        prNumber: existingPr.prNumber,
        prTitle: `${ticketKey}: ${toText(ticket.summary).trim()}`,
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

    const status = runCommand('git', ['status', '--porcelain'], cwd, 'Failed to inspect git status.').trim();
    const localBranchExists = runCommand('git', ['branch', '--list', branchName], cwd, 'Failed to inspect local branches.').trim().length > 0;
    let remoteBranchExists = false;
    try {
      remoteBranchExists = runCommand('git', ['ls-remote', '--heads', 'origin', branchName], cwd, 'Failed to inspect remote branches.').trim().length > 0;
    } catch {
      remoteBranchExists = false;
    }
    const branchIsReadyForPr = currentBranch === branchName || localBranchExists || remoteBranchExists;
    if (!status && !branchIsReadyForPr) {
      const output = {
        prUrl: null,
        prNumber: null,
        prTitle: `${ticketKey}: ${toText(ticket.summary).trim()}`,
        branch: branchName,
        commitSha: runCommand('git', ['rev-parse', 'HEAD'], cwd, 'Failed to resolve current commit SHA.').trim(),
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

    const existingBranch = localBranchExists
      ? runCommand('git', ['branch', '--list', branchName], cwd, 'Failed to inspect local branches.').trim()
      : '';
    if (currentBranch !== branchName) {
      if (existingBranch) {
        runCommand('git', ['checkout', branchName], cwd, `Failed to checkout existing branch "${branchName}".`);
      } else {
        await executeSideEffect(context.state, 'git-branch', { branchName, cwd }, async () => {
          runCommand('git', ['checkout', '-b', branchName], cwd, `Failed to create branch "${branchName}".`);
          return { branchName };
        });
      }
    }

    if (status) {
      runCommand('git', ['add', '-A'], cwd, 'Failed to stage changes with git add -A.');
    }

    const profile = readProfile(context);
    const commitMessage = `${ticketKey}: ${toText(ticket.summary).trim()}\n\nAutomated implementation by AgentOne pipeline.\nRun: ${runId}\nProfile: ${profile}`;
    const commitMessagePath = path.join(cwd, `.agentone-commit-${runId}.txt`);
    writeFileSync(commitMessagePath, commitMessage, 'utf8');
    try {
      if (status) {
        runCommand('git', ['commit', '-F', commitMessagePath], cwd, 'Failed to commit changes.');
      }
    } finally {
      try {
        unlinkSync(commitMessagePath);
      } catch {
        // Ignore cleanup failures
      }
    }

    try {
      runCommand('git', ['push', '-u', 'origin', branchName], cwd, 'Failed to push branch.');
    } catch (error) {
      throw new Error(
        `Failed to push branch "${branchName}" to origin. Ensure git remote "origin" exists and authentication is configured.\n${error instanceof Error ? error.message : String(error)}`
      );
    }

    const prTitle = `${ticketKey}: ${toText(ticket.summary).trim()}`;
    const prBody = buildPrBody(ticket, plan, implement.summary, verifyResult, {
      runId,
      profile,
      totalCost: context.costTracker?.getRunCost?.().totalCost ?? 0,
    });
    const prBodyPath = path.join(cwd, `.agentone-pr-body-${runId}.md`);
    writeFileSync(prBodyPath, prBody, 'utf8');

    const prEffect = await executeSideEffect(context.state, 'pr-created', { branchName, cwd }, async () => {
      let prResult = '';
      try {
        prResult = runCommand(
          'gh',
          ['pr', 'create', '--title', prTitle, '--body-file', prBodyPath],
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
      return prResult;
    });

    const latestPr = prEffect.alreadyDone
      ? parsePrInfo(runCommand('gh', ['pr', 'list', '--head', branchName, '--json', 'number,url'], cwd, 'Failed to reload existing pull request.'))
      : null;
    const prUrl = prEffect.alreadyDone ? latestPr?.prUrl || null : parsePrUrl(prEffect.result);
    const prNumber = prEffect.alreadyDone
      ? latestPr?.prNumber || null
      : (() => {
          const prNumberMatch = prUrl ? prUrl.match(/\/pull\/(\d+)(?:\D|$)/) : null;
          return prNumberMatch ? Number(prNumberMatch[1]) : null;
        })();
    const commitSha = runCommand('git', ['rev-parse', 'HEAD'], cwd, 'Failed to resolve current commit SHA.').trim();

    const output = {
      prUrl,
      prNumber,
      prTitle,
      branch: branchName,
      commitSha,
      skipped: false,
      reason: null,
    };

    const effects = getSideEffects(context.state);
    if (effects.length > 0) {
      writeCompensationFile(context.runDir || context.state.getRunDir?.() || '.', effects);
    }

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
    const effects = getSideEffects(context.state);
    if (effects.length > 0) {
      writeCompensationFile(context.runDir || context.state.getRunDir?.() || '.', effects);
    }
    context.logger?.log({
      type: 'STAGE_FAILED',
      stage: STAGE_NAME,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
