import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { TIMEOUTS } from '../pipeline-config.js';
import { runAgent } from '../lib/agent-runner.js';
import { assembleContext } from '../lib/context-assembler.js';
import { CostTracker } from '../lib/cost-tracker.js';

const STAGE_NAME = 'implement';
const COMPLETED_REGEX = /<COMPLETED>([\s\S]*?)<\/COMPLETED>/;
const MAX_PARALLEL_AGENTS = 6;

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

/**
 * Use Claude to decompose a plan into independent subtasks for parallel implementation.
 * Returns null on failure (caller falls back to single-agent mode).
 */
async function decomposeIntoSubtasks(planText, ticketKey, ticketSummary, context, worktreePath) {
  const prompt = [
    `You are a task decomposition agent. Break an implementation plan into independent subtasks that can be worked on in parallel by separate agents.`,
    ``,
    `## Ticket: ${ticketKey}`,
    `**Summary:** ${ticketSummary}`,
    ``,
    `## Implementation Plan`,
    planText,
    ``,
    `## Your Task`,
    ``,
    `Analyze this plan and split it into independent subtasks. Each subtask will be given to a separate Codex agent that works in the same codebase.`,
    ``,
    `Rules:`,
    `- Each subtask must have a CLEAR, NON-OVERLAPPING file scope — no two subtasks should modify the same file`,
    `- If two changes depend on the same file, they MUST be in the same subtask`,
    `- Order matters: if subtask B imports from a file created in subtask A, mark that dependency`,
    `- Simple plans (1-3 files) should be a SINGLE subtask — don't over-split`,
    `- Maximum ${MAX_PARALLEL_AGENTS} subtasks`,
    `- Each subtask needs: a label, the specific files it will create/modify, and clear instructions`,
    ``,
    `## Output Format`,
    ``,
    `Respond with EXACTLY this JSON inside COMPLETED tags:`,
    ``,
    `<COMPLETED>`,
    `{`,
    `  "strategy": "single" or "parallel",`,
    `  "reasoning": "One sentence explaining why single vs parallel",`,
    `  "subtasks": [`,
    `    {`,
    `      "label": "short-label",`,
    `      "files": ["src/foo.js", "src/bar.js"],`,
    `      "instructions": "What to implement in this subtask",`,
    `      "dependsOn": []`,
    `    }`,
    `  ]`,
    `}`,
    `</COMPLETED>`,
    ``,
    `If the plan is simple enough for one agent, use strategy "single" with one subtask containing the full plan.`
  ].join('\n');

  try {
    const result = await runAgent({
      cli: 'claude',
      prompt,
      cwd: worktreePath,
      timeout: 120_000,
      label: `implement-decompose-${ticketKey}`,
      metadata: { stage: STAGE_NAME, step: 'decompose', ticketKey, runId: context.state.runId },
      extractRegex: COMPLETED_REGEX
    });

    if (context.costTracker && result.sessionId) {
      context.costTracker.recordCall(STAGE_NAME, CostTracker.fromAgentResult(result));
    }

    if (!result.success || !result.content) return null;

    const parsed = JSON.parse(result.content);
    if (!parsed?.subtasks || !Array.isArray(parsed.subtasks) || parsed.subtasks.length === 0) return null;

    return parsed;
  } catch (err) {
    context.logger?.log({
      type: 'GATE_CHECK',
      stage: STAGE_NAME,
      gate: 'decompose_failed',
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

/**
 * Build an implementation prompt for a single subtask.
 */
function buildSubtaskPrompt(subtask, ticketKey, ticketSummary, fullPlan, profile) {
  return [
    `You are an expert software engineer implementing a SPECIFIC SUBTASK of a larger plan.`,
    ``,
    `## Ticket: ${ticketKey}`,
    `**Summary:** ${ticketSummary}`,
    `**Profile:** ${profile}`,
    ``,
    `## Full Implementation Plan (for context only)`,
    fullPlan,
    ``,
    `## YOUR SUBTASK: ${subtask.label}`,
    ``,
    `**Files you own:** ${subtask.files.join(', ')}`,
    ``,
    `**Instructions:**`,
    subtask.instructions,
    ``,
    `## Rules`,
    `- ONLY modify or create the files listed above — do NOT touch other files`,
    `- Follow existing code style and conventions`,
    `- Write clean, production-quality code`,
    `- Run tests after your changes if applicable`,
    ``,
    `## Completion`,
    `<COMPLETED>`,
    `[Summary of what you implemented and any issues encountered]`,
    `</COMPLETED>`
  ].join('\n');
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

    // Step 1: Decompose plan into subtasks
    context.logger?.log({ type: 'GATE_CHECK', stage: STAGE_NAME, gate: 'decompose_start' });

    const decomposition = await decomposeIntoSubtasks(planText, ticketKey, ticketSummary, context, worktreePath);
    const useParallel = decomposition?.strategy === 'parallel' && decomposition.subtasks.length > 1;

    let implSummaries;

    if (useParallel) {
      // ── Parallel implementation: N Codex agents on non-overlapping files ──
      const subtasks = decomposition.subtasks.slice(0, MAX_PARALLEL_AGENTS);

      context.logger?.log({
        type: 'GATE_CHECK',
        stage: STAGE_NAME,
        gate: 'parallel_start',
        subtaskCount: subtasks.length,
        labels: subtasks.map(s => s.label),
        reasoning: decomposition.reasoning
      });

      // Split into waves: subtasks with no dependencies run first, then dependents
      const wave1 = subtasks.filter(s => !s.dependsOn || s.dependsOn.length === 0);
      const wave2 = subtasks.filter(s => s.dependsOn && s.dependsOn.length > 0);

      const runSubtaskWave = async (wave, waveLabel) => {
        const promises = wave.map(subtask => {
          const subtaskPrompt = buildSubtaskPrompt(subtask, ticketKey, ticketSummary, planText, profile);
          return runAgent({
            cli: 'codex',
            prompt: subtaskPrompt,
            cwd: worktreePath,
            timeout: TIMEOUTS.implement,
            label: `implement-${subtask.label}-${ticketKey}`,
            extraArgs: ['--full-auto'],
            metadata: {
              stage: STAGE_NAME,
              cli: 'codex',
              step: 'implement',
              subtask: subtask.label,
              wave: waveLabel,
              ticketKey,
              runId: context.state.runId
            },
            extractRegex: COMPLETED_REGEX
          }).catch(err => ({
            success: false,
            content: null,
            fullOutput: `Error: ${err instanceof Error ? err.message : String(err)}`,
            timedOut: false,
            durationMs: 0,
            sessionId: null
          }));
        });

        return Promise.all(promises);
      };

      // Run wave 1 (independent subtasks) in parallel
      const wave1Results = await runSubtaskWave(wave1, 'wave1');

      // Record costs for wave 1
      for (const result of wave1Results) {
        if (context.costTracker && result.sessionId) {
          context.costTracker.recordCall(STAGE_NAME, CostTracker.fromAgentResult(result));
        }
      }

      const wave1Success = wave1Results.filter(r => r.success).length;
      context.logger?.log({
        type: 'GATE_CHECK',
        stage: STAGE_NAME,
        gate: 'wave1_done',
        success: wave1Success,
        total: wave1.length
      });

      // Run wave 2 (dependent subtasks) if any
      let wave2Results = [];
      if (wave2.length > 0) {
        wave2Results = await runSubtaskWave(wave2, 'wave2');
        for (const result of wave2Results) {
          if (context.costTracker && result.sessionId) {
            context.costTracker.recordCall(STAGE_NAME, CostTracker.fromAgentResult(result));
          }
        }

        const wave2Success = wave2Results.filter(r => r.success).length;
        context.logger?.log({
          type: 'GATE_CHECK',
          stage: STAGE_NAME,
          gate: 'wave2_done',
          success: wave2Success,
          total: wave2.length
        });
      }

      const allResults = [...wave1Results, ...wave2Results];
      const allSubtasks = [...wave1, ...wave2];
      const successCount = allResults.filter(r => r.success).length;

      if (successCount === 0) {
        throw new Error(`All ${allResults.length} implementation subtasks failed.`);
      }

      implSummaries = allSubtasks.map((s, i) => {
        const r = allResults[i];
        return `### ${s.label} (${r.success ? 'done' : 'failed'})\n${r.content || r.fullOutput || '(no output)'}`;
      });

      context.logger?.log({
        type: 'GATE_CHECK',
        stage: STAGE_NAME,
        gate: 'parallel_done',
        successCount,
        totalSubtasks: allResults.length
      });

    } else {
      // ── Single agent implementation (simple plans or decomposer fallback) ──
      context.logger?.log({ type: 'GATE_CHECK', stage: STAGE_NAME, gate: 'single_agent_start' });

      const implResult = await runAgent({
        cli: 'codex',
        prompt: assembledPrompt,
        cwd: worktreePath,
        timeout: TIMEOUTS.implement,
        label: `implement-codex-${ticketKey}`,
        extraArgs: ['--full-auto'],
        metadata: { stage: STAGE_NAME, cli: 'codex', step: 'implement', ticketKey, runId: context.state.runId },
        extractRegex: COMPLETED_REGEX
      });

      if (context.costTracker) {
        const callData = CostTracker.fromAgentResult(implResult);
        if (!callData.label) callData.label = `implement-codex-${ticketKey}`;
        context.costTracker.recordCall(STAGE_NAME, callData);
      }

      if (implResult.timedOut) {
        throw new Error(`Implement stage (codex) timed out after ${TIMEOUTS.implement}ms for ticket ${ticketKey}.`);
      }

      if (!implResult.content) {
        const partialLen = (implResult.fullOutput || '').length;
        throw new Error(`Implement stage (codex) did not return a <COMPLETED> tag. Partial output length: ${partialLen}.`);
      }

      implSummaries = [implResult.content];
    }

    const combinedImplSummary = implSummaries.join('\n\n');

    // Step 2: Collect the diff of what was written
    let codexDiff = '';
    try {
      codexDiff = execFileSync('git', ['diff', '--no-color'], {
        cwd: worktreePath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000
      });
      // Include staged changes too
      const stagedDiff = execFileSync('git', ['diff', '--cached', '--no-color'], {
        cwd: worktreePath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000
      });
      if (stagedDiff) codexDiff += '\n' + stagedDiff;
    } catch {
      codexDiff = '(unable to collect git diff)';
    }

    // Step 3: Claude reviews Codex's code and fixes any issues
    // Skip when AGENTONE_SKIP_REVIEW=1 (dispatcher will review manually)
    const skipReview = process.env.AGENTONE_SKIP_REVIEW === '1';
    let reviewContent = 'Review skipped — dispatcher will review.';
    let reviewSessionId = null;
    let reviewDurationMs = 0;

    if (!skipReview) {
      const reviewPrompt = [
        `You are a senior engineer reviewing code changes made by ${useParallel ? 'multiple agents' : 'another agent'} for ticket ${ticketKey}.`,
        `**Summary:** ${ticketSummary}`,
        '',
        '## Implementation Plan That Was Followed',
        planText,
        '',
        '## Code Changes To Review',
        codexDiff || '(no diff detected — check for new untracked files)',
        '',
        `## Implementation Summary${useParallel ? ' (from parallel agents)' : ''}`,
        combinedImplSummary,
        '',
        '## Your Task',
        '1. Review the code changes against the plan — check for correctness, missed edge cases, bugs, security issues, and code quality.',
        ...(useParallel ? [
          '2. **CRITICAL — Integration review**: Multiple agents worked in parallel on different files. Check that imports, interfaces, and data flow between their changes are consistent. Fix any mismatches.',
          '3. If you find issues, **fix them directly** in the files. You have full file system access.',
          '4. If the code is correct and complete, state that clearly.',
        ] : [
          '2. If you find issues, **fix them directly** in the files. You have full file system access.',
          '3. If the code is correct and complete, state that clearly.',
        ]),
        '',
        'When done, wrap your review in:',
        '<COMPLETED>',
        '[Your review: what was correct, what you fixed (if anything), and final assessment]',
        '</COMPLETED>'
      ].join('\n');

      const reviewResult = await runAgent({
        cli: 'claude',
        prompt: reviewPrompt,
        cwd: worktreePath,
        timeout: TIMEOUTS.implement,
        label: `implement-review-claude-${ticketKey}`,
        metadata: { stage: STAGE_NAME, cli: 'claude', step: 'review', ticketKey, runId: context.state.runId }
      });

      if (context.costTracker) {
        const reviewCallData = CostTracker.fromAgentResult(reviewResult);
        if (!reviewCallData.label) reviewCallData.label = `implement-review-${ticketKey}`;
        context.costTracker.recordCall(STAGE_NAME, reviewCallData);
      }

      if (reviewResult.timedOut) {
        context.logger?.log({
          type: 'STAGE_WARNING',
          stage: STAGE_NAME,
          message: `Claude review timed out after ${TIMEOUTS.implement}ms — proceeding with Codex implementation as-is.`
        });
      }

      reviewContent = reviewResult.content?.trim() || 'Review skipped or timed out.';
      reviewSessionId = reviewResult.sessionId || null;
      reviewDurationMs = reviewResult.durationMs || 0;
    } else {
      context.logger?.log({
        type: 'STAGE_INFO',
        stage: STAGE_NAME,
        message: 'Claude review skipped (AGENTONE_SKIP_REVIEW=1) — dispatcher will review diff manually.'
      });
    }

    const output = {
      summary: reviewContent,
      codexSummary: combinedImplSummary,
      codexDiff: codexDiff || null,
      reviewSessionId,
      reviewSkipped: skipReview,
      parallelMode: useParallel,
      subtaskCount: useParallel ? decomposition.subtasks.length : 1,
      durationMs: reviewDurationMs,
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
