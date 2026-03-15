export const BRIDGE_URL = process.env.AGENTONE_BRIDGE_URL || process.env.BRIDGE_URL || 'http://localhost:3222';
export const API_TOKEN = process.env.AGENTONE_API_TOKEN || process.env.BRIDGE_API_TOKEN || '';

export const DEFAULTS = {
  pollInterval: 3_000,
  stepTimeout: 300_000,
  maxConvergenceRounds: 'auto',
  debateSafetyCap: 10,
  maxFixAttempts: 2,
  completedRegex: /<COMPLETED>([\s\S]*?)<\/COMPLETED>/
};

/**
 * Pipeline profiles — stage lists, budgets, and bounds.
 *
 * Budget model: single budget value per profile.
 *   - Warning at 80% of budget
 *   - Hard pause at 100% of budget
 *
 * Source: FINAL-converged-architecture.md lines 128-165
 */
export const PROFILES = {
  simple: {
    stages: ['intake', 'classify', 'plan', 'implement', 'verify', 'pr-create', 'jira-close'],
    budget: 15,
    maxConvergenceRounds: 0,  // no debate for simple profile
    maxFixAttempts: 1
  },
  standard: {
    stages: [
      'intake',
      'classify',
      'plan',
      'cross-critique',
      'human-gate',
      'implement',
      'verify',
      'fix-loop',
      'test-suite',
      'browser-test',
      'security-audit',
      'pr-create',
      'jira-close'
    ],
    budget: 60,
    maxConvergenceRounds: 'auto',
    maxFixAttempts: 2
  },
  complex: {
    stages: [
      'intake',
      'classify',
      'research',
      'dual-plan',
      'cross-critique',
      'human-gate',
      'implement',
      'verify',
      'fix-loop',
      'test-suite',
      'browser-test',
      'security-audit',
      'human-gate',
      'pr-create',
      'jira-close'
    ],
    budget: 150,
    maxConvergenceRounds: 'auto',
    maxFixAttempts: 3,
    adversarialCritique: true
  },
  research: {
    stages: [
      'intake',
      'classify',
      'research'
    ],
    budget: 50,
    maxConvergenceRounds: 'auto',
    maxFixAttempts: 0
  }
};

/**
 * Auto-upgrade thresholds (architecture plan lines 169-171).
 * A run can upgrade its profile mid-flight but never downgrade.
 */
export const AUTO_UPGRADE = {
  simpleToStandard: { diffLinesExceeds: 200 },
  standardToComplex: { securityConcerns: true, multiComponentDeps: true },
  anyToPaused: { budgetWarningRatio: 0.8 }
};

export const AGENT_DEFAULTS = {
  claude: {
    timeout: 1_800_000,
    extraArgs: ['--output-format', 'json', '--dangerously-skip-permissions']
  },
  codex: {
    timeout: 1_800_000,
    model: 'gpt-5.4',
    extraArgs: ['--skip-git-repo-check']
  }
};

export const TIMEOUTS = {
  intake: 300_000,
  classify: 120_000,
  plan: 3_600_000,
  'dual-plan': 3_600_000,
  'cross-critique': 3_600_000,
  'human-gate': 86_400_000,
  implement: 14_400_000,
  verify: 3_600_000,
  'fix-loop': 3_600_000,
  research: 3_600_000,
  'test-suite': 3_600_000,
  'browser-test': 3_600_000,
  'security-audit': 1_800_000,
  'pr-create': 600_000,
  'jira-close': 300_000
};

/**
 * Derive budget thresholds from a profile's single budget value.
 * @param {number} budget — total budget in USD
 * @returns {{ warning: number, hard: number }}
 */
export function budgetThresholds(budget) {
  return {
    warning: Math.round(budget * 0.8 * 100) / 100,
    hard: budget
  };
}
