import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { TIMEOUTS } from '../pipeline-config.js';
import { runAgent } from '../lib/agent-runner.js';
import { assembleContext } from '../lib/context-assembler.js';
import { CostTracker } from '../lib/cost-tracker.js';

const STAGE_NAME = 'implement';

const TEMPLATE_PATH = new URL('../prompts/implement.md', import.meta.url);

function replaceAll(template, placeholder, value) {
  return template.split(placeholder).join(value);
}

function sanitizeSegment(value, fallback = 'run') {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function runGit(args, cwd, errorPrefix) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (error) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : '';
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    const details = [stdout, stderr].filter(Boolean).join('\n');
    throw new Error(details ? `${errorPrefix}\n${details}` : errorPrefix);
  }
}

function ensureWorktree(context, ticketKey) {
  const existingPath = context.state.getMetadata?.('worktreePath');
  if (existingPath && fs.existsSync(existingPath)) {
    return {
      worktreePath: existingPath,
      branchName: context.state.getMetadata?.('worktreeBranch') || null
    };
  }

  const baseWorkingDirectory = context.state.getMetadata?.('baseWorkingDirectory')
    || context.state.getWorkingDirectory?.()
    || context.workDir;
  if (!baseWorkingDirectory) {
    throw new Error('Implement stage requires a resolved base working directory before creating a worktree.');
  }

  const repoRoot = runGit(['rev-parse', '--show-toplevel'], baseWorkingDirectory, 'Failed to resolve git repository root.');
  const worktreeRoot = path.join(repoRoot, '.pipeline-worktrees');
  const worktreePath = path.join(worktreeRoot, sanitizeSegment(context.state.runId, 'run'));
  const branchName = `pipeline/${sanitizeSegment(context.state.runId, 'run')}/${sanitizeSegment(ticketKey, 'ticket')}`;

  fs.mkdirSync(worktreeRoot, { recursive: true });

  if (!fs.existsSync(worktreePath)) {
    runGit(['worktree', 'add', '-b', branchName, worktreePath], repoRoot, `Failed to create git worktree at ${worktreePath}.`);
  }

  if (typeof context.state?.setWorktree === 'function') {
    context.state.setWorktree({
      worktreePath,
      branchName,
      baseWorkingDirectory: repoRoot
    });
  }

  return { worktreePath, branchName };
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

    let worktreePath, branchName;
    if (context.noWorktree) {
      // Use the specified workDir directly — no git worktree
      worktreePath = context.workDir || context.workingDirectory;
      branchName = null;
      if (!worktreePath) {
        throw new Error('--no-worktree requires --workdir to be set.');
      }
    } else {
      ({ worktreePath, branchName } = ensureWorktree(context, ticketKey));
    }

    let template;
    try {
      template = await fsp.readFile(TEMPLATE_PATH, 'utf8');
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

    const humanRevision = context.state.getLatestHumanRevision?.();
    if (humanRevision?.comments) {
      assembledPrompt += `\n\n## Human Revision Request\n${humanRevision.comments}`;
    }

    // Use Claude for implementation — Codex's --sandbox read-only prevents file writes.
    // Codex is used in dual-plan (planning only); Claude handles implementation.
    const result = await runAgent({
      cli: 'claude',
      prompt: assembledPrompt,
      cwd: worktreePath,
      timeout: TIMEOUTS.implement,
      label: `implement-claude-${ticketKey}`,
      metadata: { stage: STAGE_NAME, cli: 'claude', ticketKey, runId: context.state.runId }
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
      success: result.success,
      workingDirectory: worktreePath,
      branchName
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
