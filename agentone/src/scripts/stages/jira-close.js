import { executeSideEffect, getSideEffects, writeCompensationFile } from '../lib/side-effects.js';

const STAGE_NAME = 'jira-close';

const PREFERRED_TRANSITION_NAMES = ['In Review', 'Review', 'Done', 'Closed', 'Resolved'];

function requireJiraCredentials() {
  const required = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'];
  const missing = required.filter((name) => !process.env[name] || !String(process.env[name]).trim());

  if (missing.length > 0) {
    throw new Error(
      `Missing required Jira environment variables: ${missing.join(', ')}. Required: ${required.join(', ')}`
    );
  }

  return {
    baseUrl: String(process.env.JIRA_BASE_URL).replace(/\/+$/, ''),
    email: String(process.env.JIRA_EMAIL),
    token: String(process.env.JIRA_API_TOKEN),
  };
}

function buildAuthHeader(email, token) {
  return `Basic ${Buffer.from(email + ':' + token).toString('base64')}`;
}

function asNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getTicketKey(context) {
  const intake = context?.state?.getStageOutput?.('intake');
  const fromIntake = asNonEmptyString(intake?.key);
  const fromContext = asNonEmptyString(context?.ticketKey);
  return fromIntake || fromContext || null;
}

function getPrDetails(context) {
  const prOutput = context?.state?.getStageOutput?.('pr-create') || {};
  const prUrl = asNonEmptyString(prOutput.prUrl);
  const ticket = context?.state?.getStageOutput?.('intake') || {};
  const fallbackTitle = [ticket?.key, ticket?.summary].filter(Boolean).join(': ').trim();

  return {
    prUrl,
    prTitle: asNonEmptyString(prOutput.prTitle) || fallbackTitle || 'Automated Pull Request',
    skipped: Boolean(prOutput.skipped),
    reason: asNonEmptyString(prOutput.reason),
  };
}

function getRunMetadata(context) {
  const runId = asNonEmptyString(context?.state?.runId) || 'unknown';
  const profile =
    asNonEmptyString(context?.state?.toJSON?.()?.profile) ||
    asNonEmptyString(context?.config?.profile) ||
    'unknown';

  return { runId, profile };
}

async function jiraRequest(credentials, method, apiPath, body) {
  const auth = buildAuthHeader(credentials.email, credentials.token);
  const response = await fetch(`${credentials.baseUrl}${apiPath}`, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: auth,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const detail = data?.errorMessages?.join('; ') || text || 'No response body';
    throw new Error(`Jira API ${method} ${apiPath} failed with HTTP ${response.status}: ${detail}`);
  }

  return { data, text };
}

function chooseTransition(transitions) {
  if (!Array.isArray(transitions) || transitions.length === 0) {
    return null;
  }

  const exactTargets = PREFERRED_TRANSITION_NAMES.map((name) => name.toLowerCase());

  for (const candidate of transitions) {
    const name = String(candidate?.name || '').trim();
    if (!name) continue;
    if (exactTargets.includes(name.toLowerCase())) {
      return candidate;
    }
  }

  const containsMatchers = ['review', 'done', 'close', 'resolve'];
  for (const candidate of transitions) {
    const name = String(candidate?.name || '').trim().toLowerCase();
    if (!name) continue;
    if (containsMatchers.some((fragment) => name.includes(fragment))) {
      return candidate;
    }
  }

  return null;
}

function warn(context, message, details = undefined) {
  context?.logger?.log?.({
    type: 'GATE_CHECK',
    stage: STAGE_NAME,
    passed: false,
    message,
    details,
  });
  console.warn(`[${STAGE_NAME}] ${message}`);
}

export async function run(context) {
  context.state.stageStart(STAGE_NAME);
  context.logger?.log({ type: 'STAGE_STARTED', stage: STAGE_NAME });

  try {
  const ticketKey = getTicketKey(context);
  if (!ticketKey) {
    throw new Error("jira-close requires ticket key from stage 'intake' or context.ticketKey.");
  }

  const credentials = requireJiraCredentials();
  const { prUrl, prTitle, skipped, reason } = getPrDetails(context);
  const { runId, profile } = getRunMetadata(context);

  const output = {
    commentAdded: false,
    remoteLinkAdded: false,
    transitioned: false,
    transitionName: null,
    ticketKey,
  };

  const issueKey = encodeURIComponent(ticketKey);

  if (prUrl) {
    const commentBody = `Pull request created by AgentOne pipeline: ${prUrl}\n\nRun: ${runId}\nProfile: ${profile}`;
    try {
      await jiraRequest(credentials, 'POST', `/rest/api/2/issue/${issueKey}/comment`, {
        body: commentBody,
      });
      output.commentAdded = true;
    } catch (error) {
      warn(context, `Failed to add Jira comment for ${ticketKey}`, error instanceof Error ? error.message : String(error));
    }

    try {
      await jiraRequest(credentials, 'POST', `/rest/api/2/issue/${issueKey}/remotelink`, {
        object: { url: prUrl, title: `PR: ${prTitle}` },
      });
      output.remoteLinkAdded = true;
    } catch (error) {
      warn(
        context,
        `Failed to add Jira remote link for ${ticketKey}`,
        error instanceof Error ? error.message : String(error)
      );
    }
  } else {
    const noChangeReason = skipped
      ? reason || 'No changes detected'
      : 'PR creation stage missing or did not return a PR URL';
    const commentBody =
      `No pull request was created by AgentOne pipeline: ${noChangeReason}\n\n` +
      `Pipeline found no changes needed.\n\nRun: ${runId}\nProfile: ${profile}`;

    try {
      await jiraRequest(credentials, 'POST', `/rest/api/2/issue/${issueKey}/comment`, {
        body: commentBody,
      });
      output.commentAdded = true;
    } catch (error) {
      warn(context, `Failed to add no-change Jira comment for ${ticketKey}`, error instanceof Error ? error.message : String(error));
    }
  }

  try {
    const transitionEffect = await executeSideEffect(context.state, 'jira-transition', { ticketKey }, async () => {
      const transitionsResponse = await jiraRequest(
        credentials,
        'GET',
        `/rest/api/2/issue/${issueKey}/transitions`
      );
      const transitions = Array.isArray(transitionsResponse.data?.transitions)
        ? transitionsResponse.data.transitions
        : [];

      const selected = chooseTransition(transitions);
      if (!selected?.id) {
        warn(
          context,
          `No suitable Jira transition found for ${ticketKey}`,
          `Available: ${transitions.map((t) => t?.name).filter(Boolean).join(', ') || 'none'}`
        );
        return { transitioned: false };
      } else {
        await jiraRequest(credentials, 'POST', `/rest/api/2/issue/${issueKey}/transitions`, {
          transition: { id: String(selected.id) },
        });
        return { transitioned: true, name: selected.name };
      }
    });

    if (!transitionEffect.alreadyDone && transitionEffect.result?.transitioned) {
      output.transitioned = true;
      output.transitionName = String(transitionEffect.result.name || '').trim() || null;
    }
  } catch (error) {
    warn(context, `Failed to transition Jira ticket ${ticketKey}`, error instanceof Error ? error.message : String(error));
  }

  const effects = getSideEffects(context.state);
  if (effects.length > 0) {
    writeCompensationFile(context.runDir || context.state.getRunDir?.() || '.', effects);
  }

  context.state.checkpoint(STAGE_NAME, output);
  context.logger?.log({ type: 'STAGE_COMPLETED', stage: STAGE_NAME });

  return output;
  } catch (error) {
    const effects = getSideEffects(context.state);
    if (effects.length > 0) {
      writeCompensationFile(context.runDir || context.state.getRunDir?.() || '.', effects);
    }
    context.logger?.log({
      type: 'STAGE_FAILED',
      stage: STAGE_NAME,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}