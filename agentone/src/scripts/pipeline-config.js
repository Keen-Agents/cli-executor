export const BRIDGE_URL = process.env.AGENTONE_BRIDGE_URL || process.env.BRIDGE_URL || 'http://localhost:3222';
export const API_TOKEN = process.env.AGENTONE_API_TOKEN || process.env.BRIDGE_API_TOKEN || '';

export const DEFAULTS = {
  pollInterval: 3_000,
  stepTimeout: 300_000,
  maxConvergenceRounds: 2,
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
    maxConvergenceRounds: 0,
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
    maxConvergenceRounds: 1,
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
    maxConvergenceRounds: 2,
    maxFixAttempts: 3,
    adversarialCritique: true
  },
  research: {
    stages: [
      'intake',
      'classify',
      'research'
    ],
    budget: 30,
    maxConvergenceRounds: 0,
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
    timeout: 300_000,
    extraArgs: ['--output-format', 'json', '--dangerously-skip-permissions']
  },
  codex: {
    timeout: 300_000,
    model: 'gpt-5.4',
    extraArgs: []
  }
};

export const TIMEOUTS = {
  intake: 120_000,
  classify: 30_000,
  plan: 300_000,
  'dual-plan': 420_000,
  'cross-critique': 420_000,
  'human-gate': 86_400_000,
  implement: 900_000,
  verify: 600_000,
  'fix-loop': 420_000,
  research: 300_000,
  'test-suite': 600_000,
  'browser-test': 600_000,
  'security-audit': 300_000,
  'pr-create': 180_000,
  'jira-close': 120_000
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
