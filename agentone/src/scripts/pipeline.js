import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PipelineState } from './lib/state-manager.js';
import { CostTracker } from './lib/cost-tracker.js';
import { createLogger } from './lib/logger.js';
import { PROFILES, TIMEOUTS, budgetThresholds } from './pipeline-config.js';

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

const STAGE_MAP = {
  intake, classify, plan,
  'dual-plan': dualPlan,
  'cross-critique': crossCritique,
  'human-gate': humanGate,
  implement, verify,
  'fix-loop': fixLoop,
  'pr-create': prCreate,
  'jira-close': jiraClose
};

function parseArgs(argv) {
  const args = {
    ticketKey: '',
    profile: '',
    runId: '',
    resume: false
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

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.ticketKey) {
    throw new Error('Missing required argument: --ticket KEY');
  }

  if (args.profile && !PROFILES[args.profile]) {
    throw new Error(`Invalid --profile value: ${args.profile}`);
  }

  if (args.resume && !args.runId) {
    throw new Error('--resume requires --run-id ID');
  }

  if (!args.runId) {
    args.runId = `run-${Date.now()}-${args.ticketKey}`;
  }

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

async function runPipeline(input) {
  const ticketKey = input.ticketKey;
  const runId = input.runId;
  const forcedProfile = input.profile || '';
  const shouldResume = Boolean(input.resume);

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

  const thresholds = budgetThresholds(profileConfig.budget);
  const logger = createLogger(runDir, runId);
  const costTracker = new CostTracker(runDir, { soft: thresholds.warning, hard: thresholds.hard });

  console.log(`[pipeline] Starting run ${runId}`);

  let stageIndex = 0;
  while (stageIndex < stageList.length) {
    const stageName = stageList[stageIndex];
    stageIndex += 1;

    if (state.isCompleted(stageName)) {
      console.log(`[pipeline] Skipping ${stageName} (already completed)`);
      continue;
    }

    if (!STAGE_MAP[stageName]) {
      console.log(`[pipeline] Skipping ${stageName} (not implemented yet)`);
      continue;
    }

    const budgetCheck = costTracker.checkBudget();
    if (budgetCheck.status === 'exceeded') {
      state.pause('budget_exceeded', { spent: budgetCheck.spent });
      logger.log({ type: 'BUDGET_EXCEEDED', stage: stageName, spent: budgetCheck.spent });
      console.log(`[pipeline] Budget exceeded ($${budgetCheck.spent}). Pipeline paused.`);
      break;
    }

    if (budgetCheck.status === 'warning') {
      logger.log({
        type: 'BUDGET_WARNING',
        stage: stageName,
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
      ticketKey
    };

    try {
      logger.log({ type: 'STAGE_STARTED', stage: stageName });
      const result = await runWithTimeout(stageName, stageTimeout, STAGE_MAP[stageName], context);
      logger.log({ type: 'STAGE_COMPLETED', stage: stageName });

      const stageCost = costTracker.getStageCost(stageName);
      const elapsed = formatDuration(Date.now() - stageStart);

      if (stageName === 'classify' && !forcedProfile) {
        const selectedProfile = result?.profile;
        if (!selectedProfile || !PROFILES[selectedProfile]) {
          throw new Error('classify stage did not return a valid profile');
        }

        profileName = selectedProfile;
        profileConfig = PROFILES[selectedProfile];
        stageList = profileConfig.stages;
        state.setProfile(selectedProfile);

        const updatedThresholds = budgetThresholds(profileConfig.budget);
        costTracker.budgets = {
          soft: updatedThresholds.warning,
          hard: updatedThresholds.hard
        };

        console.log(`[pipeline] Stage: ${stageName}... ${selectedProfile} profile selected (${elapsed})`);
      } else {
        const costSuffix = stageCost.totalCost > 0 ? `, $${stageCost.totalCost}` : '';
        console.log(`[pipeline] Stage: ${stageName}... done (${elapsed}${costSuffix})`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.log({ type: 'STAGE_FAILED', stage: stageName, error: message });
      state.fail(stageName, err);
      console.error(`[pipeline] Stage ${stageName} failed: ${message}`);
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
  const ticketKey = dictionary?.ticketKey;
  if (!ticketKey) {
    throw new Error('exec(dictionary) requires dictionary.ticketKey');
  }

  const profile = dictionary?.profile || '';
  const runId = dictionary?.runId || '';
  const resume = Boolean(dictionary?.resume);

  const result = await runPipeline({ ticketKey, profile, runId, resume });

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
