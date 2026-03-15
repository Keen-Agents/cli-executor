// @ts-check

export const STAGE_PROFILES = {
  plan: {
    sections: [
      { key: 'research', priority: 1, maxTokens: 8000 },
      { key: 'ticket', priority: 1, maxTokens: 5000 },
      { key: 'codeOverview', priority: 1, maxTokens: 10000 },
      { key: 'repoTree', priority: 2, maxTokens: 3000 },
    ],
  },
  'cross-critique': {
    sections: [
      { key: 'otherPlan', priority: 1, maxTokens: 15000 },
      { key: 'ticket', priority: 1, maxTokens: 3000 },
      { key: 'ownPlan', priority: 2, maxTokens: 10000 },
      { key: 'priorCritique', priority: 2, maxTokens: 5000 },
    ],
  },
  implement: {
    sections: [
      { key: 'convergedPlan', priority: 1, maxTokens: 15000 },
      { key: 'ticket', priority: 1, maxTokens: 3000 },
      { key: 'research', priority: 2, maxTokens: 5000 },
      { key: 'relevantCode', priority: 1, maxTokens: 30000 },
      { key: 'critiqueSummary', priority: 3, maxTokens: 3000 },
    ],
  },
  verify: {
    sections: [
      { key: 'plan', priority: 1, maxTokens: 10000 },
      { key: 'codeDiff', priority: 1, maxTokens: 30000 },
      { key: 'testOutput', priority: 1, maxTokens: 10000 },
      { key: 'ticket', priority: 2, maxTokens: 2000 },
    ],
  },
  'fix-loop': {
    sections: [
      { key: 'testFailures', priority: 1, maxTokens: 15000 },
      { key: 'failingCode', priority: 1, maxTokens: 20000 },
      { key: 'plan', priority: 1, maxTokens: 5000 },
      { key: 'verifierNotes', priority: 1, maxTokens: 5000 },
      { key: 'priorFixAttempts', priority: 2, maxTokens: 5000 },
    ],
  },
};

export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 4);
}

export function truncateSection(content, maxTokens) {
  const safeContent = String(content ?? '');
  const estimatedTokens = estimateTokens(safeContent);
  if (estimatedTokens <= maxTokens) return safeContent;

  const lines = safeContent.split('\n');
  const keepLines = Math.floor(maxTokens / 5);
  const halfKeep = Math.floor(keepLines / 2);
  if (lines.length <= keepLines) return safeContent;

  const head = lines.slice(0, halfKeep).join('\n');
  const tail = lines.slice(-halfKeep).join('\n');
  const omitted = lines.length - keepLines;
  return `${head}\n\n... [${omitted} lines omitted] ...\n\n${tail}`;
}

function formatSection(key, content) {
  return `## ${key}\n${content}`;
}

function asText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function resolvePlan(runState, extraData) {
  const secondHumanGateOutput = runState?.getStageOutput?.('human-gate--2');
  const humanGateOutput = runState?.getStageOutput?.('human-gate');
  const critiqueOutput = runState?.getStageOutput?.('cross-critique');
  const dualPlanOutput = runState?.getStageOutput?.('dual-plan');
  const planOutput = runState?.getStageOutput?.('plan');
  return (
    asText(extraData?.finalPlan) ||
    asText(secondHumanGateOutput?.effectivePlan) ||
    asText(humanGateOutput?.effectivePlan) ||
    asText(critiqueOutput?.finalPlan) ||
    asText(dualPlanOutput?.plan) ||
    asText(planOutput?.finalPlan) ||
    asText(planOutput?.plan) ||
    ''
  );
}

function resolveContent(runState, key, extraData = {}) {
  const intakeOutput = runState?.getStageOutput?.('intake');
  const planOutput = runState?.getStageOutput?.('plan');
  const critiqueOutput = runState?.getStageOutput?.('cross-critique');
  const implementOutput = runState?.getStageOutput?.('implement');
  const verifyOutput = runState?.getStageOutput?.('verify');

  switch (key) {
    case 'ticket':
      return asText(intakeOutput);
    case 'plan':
    case 'convergedPlan':
    case 'ownPlan':
      return resolvePlan(runState, extraData);
    case 'otherPlan':
      return asText(extraData.otherPlan);
    case 'codeOverview':
      return asText(implementOutput?.summary);
    case 'testOutput':
    case 'testFailures':
      return asText(verifyOutput?.tests?.output);
    case 'codeDiff':
      return asText(extraData.codeDiff);
    case 'priorCritique':
      return asText(extraData.priorCritique);
    case 'priorFixAttempts':
      return asText(extraData.priorFixAttempts);
    case 'verifierNotes':
      return asText(verifyOutput?.summary);
    case 'repoTree':
    case 'relevantCode':
    case 'failingCode':
      return asText(extraData[key]);
    case 'critiqueSummary':
      return asText(extraData.critiqueSummary || critiqueOutput?.summary || planOutput?.critiqueSummary);
    case 'research': {
      const researchOutput = runState?.getStageOutput?.('research');
      return asText(researchOutput?.summary) || asText(researchOutput?.researchSummary) || '';
    }
    default:
      return '';
  }
}

function packByPriority(resolvedSections, contextBudget) {
  if (!Array.isArray(resolvedSections) || resolvedSections.length === 0 || contextBudget <= 0) {
    return '';
  }

  const sorted = [...resolvedSections].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return 0;
  });

  let remaining = contextBudget;
  const packed = [];

  for (const section of sorted) {
    const raw = asText(section?.content);
    if (!raw.trim()) continue;

    const perSection = truncateSection(raw, section.maxTokens);
    const wrapped = formatSection(section.key, perSection);
    const wrappedTokens = estimateTokens(wrapped);

    if (wrappedTokens <= remaining) {
      packed.push(wrapped);
      remaining -= wrappedTokens;
      continue;
    }

    const maxForRemaining = Math.max(0, remaining - estimateTokens(`## ${section.key}\n`));
    if (maxForRemaining <= 0) {
      continue;
    }

    const budgetLimited = truncateSection(raw, Math.min(section.maxTokens, maxForRemaining));
    const budgetWrapped = formatSection(section.key, budgetLimited);
    const budgetWrappedTokens = estimateTokens(budgetWrapped);

    if (budgetWrappedTokens <= remaining) {
      packed.push(budgetWrapped);
      remaining -= budgetWrappedTokens;
    }
  }

  return packed.join('\n\n');
}

export function assembleContext(runState, stageName, tokenBudget = 100000, extraData = {}) {
  const profile = STAGE_PROFILES[stageName];
  if (!profile) return '';

  const systemReserve = 5000;
  const responseReserve = 30000;
  const contextBudget = tokenBudget - systemReserve - responseReserve;

  const resolved = profile.sections.map((section) => ({
    ...section,
    content: resolveContent(runState, section.key, extraData),
  }));

  return packByPriority(resolved, contextBudget);
}
