import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import path from 'node:path';

function runCommand(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

export const SIDE_EFFECT_CHECKS = {
  'git-branch': {
    check: async (details) => {
      try {
        const result = runCommand('git', ['branch', '--list', String(details.branchName || '')], details.cwd);
        return result.trim().length > 0;
      } catch {
        return false;
      }
    },
    description: 'Git branch creation'
  },
  'pr-created': {
    check: async (details) => {
      try {
        const result = runCommand('gh', ['pr', 'list', '--head', String(details.branchName || ''), '--json', 'number'], details.cwd);
        return JSON.parse(result).length > 0;
      } catch {
        return false;
      }
    },
    description: 'Pull request creation'
  },
  'jira-transition': {
    check: async (_details) => {
      // Would need Jira API call - for now return false (always attempt)
      return false;
    },
    description: 'Jira status transition'
  }
};

export async function executeSideEffect(state, effectType, details, action) {
  const checker = SIDE_EFFECT_CHECKS[effectType];

  // Check if already done
  if (checker) {
    const alreadyDone = await checker.check(details);
    if (alreadyDone) {
      return { alreadyDone: true, details };
    }
  }

  // Perform the action
  const result = await action();

  // Record in state for compensation tracking
  recordSideEffect(state, effectType, details, result);

  return { alreadyDone: false, result };
}

function recordSideEffect(state, type, details, result) {
  const effect = {
    type,
    details,
    result,
    timestamp: new Date().toISOString()
  };

  if (typeof state?.recordSideEffect === 'function') {
    state.recordSideEffect(effect);
    return;
  }

  const stateObj = state.state || state;
  if (!stateObj.sideEffects) stateObj.sideEffects = [];
  stateObj.sideEffects.push(effect);
  state._sideEffects = stateObj.sideEffects;
}

export function writeCompensationFile(runDir, sideEffects) {
  const hints = sideEffects.map((effect) => ({
    type: effect.type,
    details: effect.details,
    undoHint: getUndoHint(effect)
  }));

  writeFileSync(
    path.join(runDir, 'compensation-needed.json'),
    JSON.stringify({ sideEffects: hints, createdAt: new Date().toISOString() }, null, 2)
  );
}

function getUndoHint(effect) {
  switch (effect.type) {
    case 'git-branch':
      return `git branch -D ${effect.details.branchName}`;
    case 'pr-created':
      return `gh pr close ${effect.details.prNumber}`;
    case 'jira-transition':
      return `Manually transition ${effect.details.ticketKey} back`;
    default:
      return 'Manual cleanup required';
  }
}

export function getSideEffects(state) {
  if (typeof state?.getSideEffects === 'function') {
    return state.getSideEffects();
  }

  if (Array.isArray(state?.state?.sideEffects)) {
    return state.state.sideEffects;
  }

  return state?._sideEffects || [];
}
