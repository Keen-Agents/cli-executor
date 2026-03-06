import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import path from 'node:path';

export const SIDE_EFFECT_CHECKS = {
  'git-branch': {
    check: async (details) => {
      try {
        const result = execSync(`git branch --list "${details.branchName}"`, { encoding: 'utf8' });
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
        const result = execSync(`gh pr list --head "${details.branchName}" --json number`, { encoding: 'utf8' });
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
  // Store on state.state so it gets serialized by PipelineState.toJSON/persistRun
  const stateObj = state.state || state;
  if (!stateObj.sideEffects) stateObj.sideEffects = [];
  stateObj.sideEffects.push({
    type,
    details,
    result,
    timestamp: new Date().toISOString()
  });
  // Also keep reference on instance for getSideEffects()
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
  return state._sideEffects || [];
}
