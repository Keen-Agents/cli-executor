import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PipelineState } from './lib/state-manager.js';
import { CostTracker } from './lib/cost-tracker.js';
import { createLogger } from './lib/logger.js';
import { PROFILES, TIMEOUTS, budgetThresholds, AUTO_UPGRADE } from './pipeline-config.js';

import { run as intake } from './stages/intake.js';
import { run as classify } from './stages/classify.js';
import { run as plan } from './stages/plan.js';
import { run as dualPlan } from './stages/dual-plan.js';
import { run as crossCritique } from './stages/cross-critique.js';
import { run as humanGate } from './stages/human-gate.js';
import { run as implement } from './stages/implement.js';
import { run as verify } from './stages/verify.js';
import { run as fixLoop } from './stages/fix-loop.js';
import { run as prCreate } from './stages/pr-create.js';
import { run as jiraClose } from './stages/jira-close.js';
import { run as research } from './stages/research.js';
import { run as testSuite } from './stages/test-suite.js';
import { run as securityAudit } from './stages/security-audit.js';
import { run as browserTest } from './stages/browser-test.js';

const STAGE_MAP = {
  intake, classify, plan,
  'dual-plan': dualPlan,
  'cross-critique': crossCritique,
  'human-gate': humanGate,
  implement, verify,
  'fix-loop': fixLoop,
  'test-suite': testSuite,
  'browser-test': browserTest,
  'security-audit': securityAudit,
  'pr-create': prCreate,
  'jira-close': jiraClose,
  research
};

const RUN_ID_PATTERN = /^[a-zA-Z0-9_.-]+$/;

function sanitizeTicketSegment(ticketKey) {
  return String(ticketKey || 'ticket')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'ticket';
}

function createRunId(ticketKey) {
  return `run-${Date.now()}-${sanitizeTicketSegment(ticketKey)}`;
}

function assertValidRunId(runId) {
  if (!runId || typeof runId !== 'string') {
    throw new Error('runId must be a non-empty string');
  }

  if (!RUN_ID_PATTERN.test(runId) || runId === '.' || runId === '..') {
    throw new Error(
      'Invalid runId. Only alphanumeric characters, dots, hyphens, and underscores are allowed.'
    );
  }
}

function resolveWorkingDirectory(inputWorkingDirectory, state) {
  const intake = state?.getStageOutput?.('intake');
  const candidates = [
    state?.getWorkingDirectory?.(),
    intake?.workingDirectory,
    inputWorkingDirectory,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return path.resolve(candidate.trim());
    }
  }

  return '';
}

function hasPendingStage(stageInstances, stageIndex, stageName) {
  return stageInstances.slice(stageIndex).some((stage) => stage.baseName === stageName);
}

function findRevisionTargetIndex(stageInstances, currentInstanceName) {
  const preferred = currentInstanceName === 'human-gate'
    ? ['dual-plan', 'plan']
    : ['implement', 'dual-plan', 'plan'];
  for (const stageName of preferred) {
    const index = stageInstances.findIndex((stage) => stage.baseName === stageName);
    if (index >= 0) {
      return index;
    }
  }

  return -1;
}

function parseArgs(argv) {
  const args = {
    ticketKey: '',
    profile: '',
    runId: '',
    resume: false,
    workingDirectory: '',
    prompt: '',
    promptFile: '',
    angles: null,
    subtasks: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--resume') {
      args.resume = true;
      continue;
    }

    if (arg === '--ticket') {
      args.ticketKey = argv[i + 1] || '';
      i += 1;
      continue;
    }

    if (arg === '--profile') {
      args.profile = argv[i + 1] || '';
      i += 1;
      continue;
    }

    if (arg === '--run-id') {
      args.runId = argv[i + 1] || '';
      i += 1;
      continue;
    }

    if (arg === '--workdir') {
      args.workingDirectory = argv[i + 1] || '';
      i += 1;
      continue;
    }

    if (arg === '--no-worktree') {
      args.noWorktree = true;
      continue;
    }

    if (arg === '--prompt') {
      args.prompt = argv[i + 1] || '';
      i += 1;
      continue;
    }

    if (arg === '--prompt-file') {
      args.promptFile = argv[i + 1] || '';
      i += 1;
      continue;
    }

    if (arg === '--angles') {
      try {
        args.angles = JSON.parse(argv[i + 1] || '[]');
      } catch {
        throw new Error('--angles must be valid JSON: [{"label":"...", "focus":"..."}]');
      }
      i += 1;
      continue;
    }

    if (arg === '--subtasks') {
      try {
        args.subtasks = JSON.parse(argv[i + 1] || '[]');
      } catch {
        throw new Error('--subtasks must be valid JSON: [{"label":"...", "files":[], "instructions":"..."}]');
      }
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.ticketKey && !args.prompt && !args.promptFile) {
    throw new Error('Missing required argument: --ticket KEY or --prompt "text" or --prompt-file path');
  }

  if (!args.ticketKey) {
    args.ticketKey = `TASK-${Date.now()}`;
  }

  if (args.profile && !PROFILES[args.profile]) {
    throw new Error(`Invalid --profile value: ${args.profile}`);
  }

  if (args.resume && !args.runId) {
    throw new Error('--resume requires --run-id ID');
  }

  if (!args.runId) {
    args.runId = createRunId(args.ticketKey);
  }

  assertValidRunId(args.runId);

  return args;
}

function formatDuration(ms) {
  const seconds = Number(ms || 0) / 1000;
  return `${seconds.toFixed(1)}s`;
}

function runExists(runId) {
  const runJsonPath = path.resolve('logs', 'pipeline-runs', runId, 'run.json');
  return fs.existsSync(runJsonPath);
}

async function runWithTimeout(stageName, timeoutMs, stageFn, context) {
  if (!timeoutMs || timeoutMs <= 0) {
    return stageFn(context);
  }

  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Stage ${stageName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([stageFn(context), timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function resolveStageInstances(stageList) {
  const counts = {};
  return stageList.map(name => {
    counts[name] = (counts[name] || 0) + 1;
    return counts[name] > 1
      ? { baseName: name, instanceName: `${name}--${counts[name]}` }
      : { baseName: name, instanceName: name };
  });
}

function buildStagePlan({ forcedProfile, state }) {
  if (forcedProfile) {
    const forced = PROFILES[forcedProfile];
    return {
      profileName: forcedProfile,
      profileConfig: forced,
      stageList: forced.stages.filter((stage) => stage !== 'classify')
    };
  }

  const savedProfile = state?.state?.profile;
  if (savedProfile && PROFILES[savedProfile]) {
    return {
      profileName: savedProfile,
      profileConfig: PROFILES[savedProfile],
      stageList: PROFILES[savedProfile].stages
    };
  }

  return {
    profileName: 'simple',
    profileConfig: PROFILES.simple,
    stageList: PROFILES.simple.stages
  };
}

const PROFILE_RANK = { simple: 0, standard: 1, complex: 2 };

function countDiffLines(workDir) {
  if (!workDir) return 0;
  try {
    // Use merge-base to diff against the branch point, not HEAD~1
    // HEAD~1 may include unrelated commits
    let base;
    try {
      base = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
        cwd: workDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000
      }).trim();
    } catch {
      // Fallback: try 'main' without origin, then HEAD~1
      try {
        base = execFileSync('git', ['merge-base', 'HEAD', 'main'], {
          cwd: workDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000
        }).trim();
      } catch {
        base = 'HEAD~1';
      }
    }
    const stat = execFileSync('git', ['diff', '--stat', base], {
      cwd: workDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000
    });
    const match = stat.match(/(\d+) insertions?\(\+\)/);
    const ins = match ? Number(match[1]) : 0;
    const delMatch = stat.match(/(\d+) deletions?\(-\)/);
    const del = delMatch ? Number(delMatch[1]) : 0;
    return ins + del;
  } catch {
    return 0;
  }
}

function checkAutoUpgrade(workDir, currentProfile) {
  const rank = PROFILE_RANK[currentProfile] ?? -1;
  if (rank >= PROFILE_RANK.standard) return null;

  const lines = countDiffLines(workDir);
  if (currentProfile === 'simple' && lines > AUTO_UPGRADE.simpleToStandard.diffLinesExceeds) {
    return { upgraded: true, newProfile: 'standard', reason: `diff lines (${lines}) exceeded threshold (${AUTO_UPGRADE.simpleToStandard.diffLinesExceeds})` };
  }

  return null;
}

function resolvePromptText(input) {
  if (input.prompt && typeof input.prompt === 'string' && input.prompt.trim()) {
    return input.prompt.trim();
  }
  if (input.promptFile && typeof input.promptFile === 'string' && input.promptFile.trim()) {
    return fs.readFileSync(path.resolve(input.promptFile.trim()), 'utf8').trim();
  }
  return '';
}

async function runPipeline(input) {
  const ticketKey = input.ticketKey;
  const runId = input.runId || createRunId(ticketKey);
  const forcedProfile = input.profile || '';
  const shouldResume = Boolean(input.resume);
  const promptText = resolvePromptText(input);
  const inputWorkingDirectory =
    typeof input.workingDirectory === 'string' && input.workingDirectory.trim()
      ? input.workingDirectory.trim()
      : '';

  assertValidRunId(runId);

  const existingRun = runExists(runId);
  if (shouldResume && !existingRun) {
    throw new Error(`Cannot resume missing run: ${runId}`);
  }
  if (!shouldResume && existingRun) {
    throw new Error(`Run ${runId} already exists. Use --resume --run-id ${runId} to continue it.`);
  }

  const state = new PipelineState(runId, { profile: forcedProfile || null });
  const runDir = state.getRunDir();

  const initialPlan = buildStagePlan({ forcedProfile, state });
  let profileName = initialPlan.profileName;
  let profileConfig = initialPlan.profileConfig;
  let stageList = initialPlan.stageList;

  if (profileName) {
    state.setProfile(profileName);
  }

  if (inputWorkingDirectory && !(shouldResume && state.getWorkingDirectory())) {
    state.setWorkingDirectory(inputWorkingDirectory, { base: true });
  }

  if (forcedProfile && !state.isCompleted('classify')) {
    state.checkpoint('classify', {
      profile: forcedProfile,
      forced: true
    });
  }

  const thresholds = budgetThresholds(profileConfig.budget);
  const logger = createLogger(runDir, runId);
  const costTracker = shouldResume
    ? CostTracker.load(runDir, { soft: thresholds.warning, hard: thresholds.hard })
    : new CostTracker(runDir, { soft: thresholds.warning, hard: thresholds.hard });

  // On resume, reset pipeline status from 'failed' back to 'running'
  if (shouldResume && (state.state.status === 'failed' || state.state.status?.startsWith('PAUSED_'))) {
    state.state.status = 'running';
    state.state.updatedAt = new Date().toISOString();
    console.log(`[pipeline] Resuming run ${runId} (was: ${state.state.status})`);
  } else {
    console.log(`[pipeline] Starting run ${runId}`);
  }

  const stageInstances = resolveStageInstances(stageList);
  let stageIndex = 0;
  while (stageIndex < stageInstances.length) {
    const { baseName: stageName, instanceName } = stageInstances[stageIndex];
    stageIndex += 1;

    if (state.isCompleted(instanceName)) {
      console.log(`[pipeline] Skipping ${instanceName} (already completed)`);
      continue;
    }

    if (!STAGE_MAP[stageName]) {
      console.log(`[pipeline] Skipping ${stageName} (not implemented yet)`);
      continue;
    }

    const budgetCheck = costTracker.checkBudget();
    if (budgetCheck.status === 'exceeded') {
      state.pause('budget_exceeded', { spent: budgetCheck.spent }, 'PAUSED_BUDGET');
      logger.log({ type: 'BUDGET_EXCEEDED', stage: instanceName, spent: budgetCheck.spent });
      console.log(`[pipeline] Budget exceeded ($${budgetCheck.spent}). Pipeline paused.`);
      break;
    }

    if (budgetCheck.status === 'warning') {
      logger.log({
        type: 'BUDGET_WARNING',
        stage: instanceName,
        spent: budgetCheck.spent,
        remaining: budgetCheck.remaining
      });
    }

    const stageStart = Date.now();
    const stageTimeout = TIMEOUTS[stageName] || 0;
    const context = {
      state,
      logger,
      costTracker,
      config: profileConfig,
      runDir,
      ticketKey,
      promptText,
      stageName: instanceName,
      workDir: resolveWorkingDirectory(inputWorkingDirectory, state),
      workingDirectory: resolveWorkingDirectory(inputWorkingDirectory, state),
      noWorktree: input.noWorktree || false,
      angles: input.angles || null,
      subtasks: input.subtasks || null
    };

    try {
      logger.log({ type: 'STAGE_STARTED', stage: instanceName });
      const result = await runWithTimeout(instanceName, stageTimeout, STAGE_MAP[stageName], context);

      const stageCost = costTracker.getStageCost(instanceName);
      const elapsed = formatDuration(Date.now() - stageStart);

      if (stageName === 'classify' && !forcedProfile) {
        const selectedProfile = result?.profile;
        if (!selectedProfile || !PROFILES[selectedProfile]) {
          throw new Error('classify stage did not return a valid profile');
        }

        profileName = selectedProfile;
        profileConfig = PROFILES[selectedProfile];
        stageList = profileConfig.stages;
        stageInstances.length = 0;
        stageInstances.push(...resolveStageInstances(stageList));
        stageIndex = 0; // Reset — isCompleted() will skip already-done stages
        state.setProfile(selectedProfile);

        const updatedThresholds = budgetThresholds(profileConfig.budget);
        costTracker.budgets = {
          soft: updatedThresholds.warning,
          hard: updatedThresholds.hard
        };

        logger.log({ type: 'STAGE_COMPLETED', stage: instanceName });

        console.log(`[pipeline] Stage: ${instanceName}... ${selectedProfile} profile selected (${elapsed})`);
      } else if (stageName === 'human-gate' && result?.decision === 'revise') {
        const rerouteIndex = findRevisionTargetIndex(stageInstances, instanceName);
        if (rerouteIndex < 0) {
          throw new Error('Human requested revisions, but no planning stage is available to rerun.');
        }

        const stagesToReset = stageInstances.slice(rerouteIndex).map((stage) => stage.instanceName);
        state.resetStages(stagesToReset);
        stageIndex = rerouteIndex;

        logger.log({
          type: 'STAGE_COMPLETED',
          stage: instanceName,
          revised: true,
          rerouteTo: stageInstances[rerouteIndex].instanceName
        });

        console.log(
          `[pipeline] Stage: ${instanceName}... revisions requested, returning to ${stageInstances[rerouteIndex].instanceName} (${elapsed})`
        );
      } else if (stageName === 'verify' && result?.passed !== true) {
        if (!hasPendingStage(stageInstances, stageIndex, 'fix-loop')) {
          throw new Error('Verification failed and no fix-loop stage remains. Stopping before side effects.');
        }

        logger.log({ type: 'STAGE_COMPLETED', stage: instanceName });
        const costSuffix = stageCost.totalCost > 0 ? `, $${stageCost.totalCost}` : '';
        console.log(`[pipeline] Stage: ${instanceName}... done (${elapsed}${costSuffix})`);
      } else if (stageName === 'fix-loop' && result?.finalVerifyPassed !== true) {
        throw new Error('Fix loop exhausted without producing a passing verification result.');
      } else {
        logger.log({ type: 'STAGE_COMPLETED', stage: instanceName });
        const costSuffix = stageCost.totalCost > 0 ? `, $${stageCost.totalCost}` : '';
        console.log(`[pipeline] Stage: ${instanceName}... done (${elapsed}${costSuffix})`);
      }

      // Auto-upgrade check after implement
      if (stageName === 'implement') {
        const upgrade = checkAutoUpgrade(
          resolveWorkingDirectory(inputWorkingDirectory, state),
          profileName
        );
        if (upgrade) {
          profileName = upgrade.newProfile;
          profileConfig = PROFILES[profileName];
          stageList = profileConfig.stages;
          stageInstances.length = 0;
          stageInstances.push(...resolveStageInstances(stageList));
          stageIndex = 0; // Reset — isCompleted() will skip already-done stages
          state.setProfile(profileName);
          const updatedThresholds = budgetThresholds(profileConfig.budget);
          costTracker.budgets = { soft: updatedThresholds.warning, hard: updatedThresholds.hard };
          logger.log({ type: 'AUTO_UPGRADE', from: 'simple', to: profileName, reason: upgrade.reason });
          console.log(`[pipeline] Auto-upgraded profile: simple → ${profileName} (${upgrade.reason})`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.log({ type: 'STAGE_FAILED', stage: instanceName, error: message });
      state.fail(instanceName, err);
      console.error(`[pipeline] Stage ${instanceName} failed: ${message}`);
      console.error(`[pipeline] To resume after fixing: --resume --run-id ${runId}`);
      break;
    }
  }

  await costTracker.save();

  const runCost = costTracker.getRunCost();
  const statusText = state.state.status === 'running' ? 'completed' : state.state.status;
  if (statusText === 'completed') {
    state.checkpoint('completed', {
      status: 'completed',
      ticketKey,
      totalCost: runCost.totalCost,
      totalCalls: runCost.totalCalls
    });
  }

  console.log(
    `[pipeline] Pipeline ${statusText} - $${runCost.totalCost} spent across ${runCost.totalCalls} agent calls`
  );

  return {
    runId,
    ticketKey,
    status: statusText,
    profile: state.state.profile || profileName,
    cost: runCost
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await runPipeline(args);
}

export async function exec(dictionary) {
  const ticketKey = dictionary?.ticketKey || '';
  const prompt = dictionary?.prompt || '';
  const promptFile = dictionary?.promptFile || '';

  if (!ticketKey && !prompt && !promptFile) {
    throw new Error('exec(dictionary) requires dictionary.ticketKey, dictionary.prompt, or dictionary.promptFile');
  }

  const effectiveKey = ticketKey || `TASK-${Date.now()}`;
  const profile = dictionary?.profile || '';
  const runId = dictionary?.runId || createRunId(effectiveKey);
  const resume = Boolean(dictionary?.resume);
  const workingDirectory = dictionary?.workingDirectory || dictionary?.workDir || '';

  const angles = dictionary?.angles || null;
  const subtasks = dictionary?.subtasks || null;

  const result = await runPipeline({ ticketKey: effectiveKey, profile, runId, resume, workingDirectory, prompt, promptFile, angles, subtasks });

  if (dictionary && typeof dictionary === 'object') {
    dictionary.response = result;
  }

  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Pipeline fatal error:', message);
    process.exit(1);
  });
}
