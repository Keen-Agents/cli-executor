// @ts-check

const STAGE_NAME = 'classify';

/**
 * @param {unknown} value
 * @returns {number}
 */
function asNumberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function asString(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * @param {Record<string, unknown>} ticket
 */
function buildSignals(ticket) {
  const labels = Array.isArray(ticket.labels)
    ? ticket.labels.filter((label) => typeof label === 'string')
    : [];
  const storyPoints = asNumberOrNull(ticket.storyPoints);
  const componentCount =
    typeof ticket.componentCount === 'number' && Number.isFinite(ticket.componentCount)
      ? ticket.componentCount
      : 0;
  const subtaskCount =
    typeof ticket.subtaskCount === 'number' && Number.isFinite(ticket.subtaskCount)
      ? ticket.subtaskCount
      : 0;
  const description = asString(ticket.description);
  const ticketType = asString(ticket.ticketType);
  const priority = asString(ticket.priority);

  return {
    forceProfile: typeof ticket.forceProfile === 'string' ? ticket.forceProfile : null,
    labels,
    storyPoints,
    componentCount,
    subtaskCount,
    descriptionLength: description.length,
    ticketType,
    priority,
  };
}

/**
 * @param {Record<string, unknown>} ticket
 * @returns {{
 *   profile: 'simple' | 'standard' | 'complex',
 *   reason: string,
 *   signals: {
 *     forceProfile: string | null,
 *     labels: string[],
 *     storyPoints: number | null,
 *     componentCount: number,
 *     subtaskCount: number,
 *     descriptionLength: number,
 *     ticketType: string,
 *     priority: string
 *   }
 * }}
 */
function classifyTicket(ticket) {
  const signals = buildSignals(ticket);
  const lowerLabels = signals.labels.map((label) => label.toLowerCase());
  const complexLabels = ['security', 'architecture', 'breaking-change', 'migration'];

  if (signals.forceProfile) {
    return {
      profile: /** @type {'simple' | 'standard' | 'complex'} */ (signals.forceProfile),
      reason: `forceProfile override '${signals.forceProfile}' set on ticket`,
      signals,
    };
  }

  const matchedComplexLabel = complexLabels.find((label) => lowerLabels.includes(label));
  if (matchedComplexLabel) {
    return {
      profile: 'complex',
      reason: `Label '${matchedComplexLabel}' detected - complex profile`,
      signals,
    };
  }

  if (signals.storyPoints !== null && signals.storyPoints >= 8) {
    return {
      profile: 'complex',
      reason: `Story points ${signals.storyPoints} >= 8 - complex profile`,
      signals,
    };
  }

  if (
    signals.storyPoints !== null &&
    signals.storyPoints <= 2 &&
    signals.componentCount <= 1
  ) {
    return {
      profile: 'simple',
      reason: `Story points ${signals.storyPoints} <= 2 and component count ${signals.componentCount} <= 1 - simple profile`,
      signals,
    };
  }

  const hasSubtasks = Boolean(ticket.hasSubtasks);
  if (hasSubtasks && signals.subtaskCount >= 4) {
    return {
      profile: 'complex',
      reason: `Has subtasks with subtask count ${signals.subtaskCount} >= 4 - complex profile`,
      signals,
    };
  }

  if (signals.descriptionLength < 200 && !hasSubtasks) {
    return {
      profile: 'simple',
      reason: `Short description (${signals.descriptionLength} chars) and no subtasks - simple profile`,
      signals,
    };
  }

  if (signals.ticketType === 'Bug' && signals.priority !== 'Critical') {
    return {
      profile: 'simple',
      reason: `Bug ticket type with non-critical priority '${signals.priority || 'Unknown'}' - simple profile`,
      signals,
    };
  }

  return {
    profile: 'standard',
    reason: 'No strong simple/complex signals matched - standard profile',
    signals,
  };
}

/**
 * @param {{
 *   state: {
 *     stageStart(stageName: string): void,
 *     getStageOutput(stageName: string): any,
 *     setProfile(profileName: string): void,
 *     checkpoint(stageName: string, output: unknown): void
 *   },
 *   logger: {
 *     log(event: { type: string, stage?: string, [key: string]: unknown }): void
 *   },
 *   costTracker: unknown,
 *   config: unknown,
 *   runDir: string
 * }} context
 */
export async function run(context) {
  const { state, logger, costTracker, config, runDir } = context;
  void costTracker;
  void config;
  void runDir;

  state.stageStart(STAGE_NAME);
  logger.log({ type: 'STAGE_STARTED', stage: STAGE_NAME });

  try {
    const ticket = state.getStageOutput('intake');
    if (!ticket || typeof ticket !== 'object') {
      throw new Error("Missing or invalid intake output. Expected normalized ticket from stage 'intake'.");
    }

    const result = classifyTicket(/** @type {Record<string, unknown>} */ (ticket));
    state.setProfile(result.profile);
    state.checkpoint(STAGE_NAME, result);
    logger.log({
      type: 'STAGE_COMPLETED',
      stage: STAGE_NAME,
      profile: result.profile,
      reason: result.reason,
    });

    return result;
  } catch (error) {
    logger.log({
      type: 'STAGE_FAILED',
      stage: STAGE_NAME,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
