const STAGE_NAME = 'intake';
const FORCE_PROFILES = new Set(['force-simple', 'force-standard', 'force-complex']);

function requireEnvVars() {
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

function stripHtml(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function textFromAdfNode(node) {
  if (!node || typeof node !== 'object') return '';

  if (node.type === 'text' && typeof node.text === 'string') {
    return node.text;
  }

  const content = Array.isArray(node.content) ? node.content : [];
  const parts = content.map((child) => textFromAdfNode(child)).filter(Boolean);
  const joined = parts.join('');

  if (['paragraph', 'heading', 'blockquote', 'listItem'].includes(node.type)) {
    return `${joined}\n`;
  }

  if (['bulletList', 'orderedList'].includes(node.type)) {
    return `${joined}\n`;
  }

  return joined;
}

function plainTextDescription(fields, renderedFields) {
  const raw = fields?.description;

  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim();
  }

  if (raw && typeof raw === 'object') {
    const text = textFromAdfNode(raw)
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (text) return text;
  }

  const rendered = renderedFields?.description;
  if (typeof rendered === 'string' && rendered.trim()) {
    return stripHtml(rendered);
  }

  return '';
}

function normalizeCommentBody(body) {
  if (typeof body === 'string') return body.trim();
  if (body && typeof body === 'object') {
    return textFromAdfNode(body)
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return '';
}

function normalizeStoryPoints(fields) {
  const direct = fields?.customfield_10016;
  if (typeof direct === 'number') return direct;

  for (const [key, value] of Object.entries(fields || {})) {
    if (!key.startsWith('customfield_')) continue;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function normalizeForceProfile(fields, labels) {
  const stripPrefix = (v) => v.replace(/^force-/, '');

  for (const label of labels) {
    if (FORCE_PROFILES.has(label)) return stripPrefix(label);
  }

  for (const value of Object.values(fields || {})) {
    if (typeof value === 'string' && FORCE_PROFILES.has(value)) {
      return stripPrefix(value);
    }
    if (value && typeof value === 'object') {
      const maybeValue = value.value;
      if (typeof maybeValue === 'string' && FORCE_PROFILES.has(maybeValue)) {
        return stripPrefix(maybeValue);
      }
    }
  }

  return null;
}

function normalizeLinkedIssues(issuelinks) {
  if (!Array.isArray(issuelinks)) return [];

  return issuelinks
    .map((link) => {
      const issue = link?.outwardIssue || link?.inwardIssue;
      if (!issue?.key) return null;
      return {
        key: issue.key,
        type: link?.type?.name || (link?.outwardIssue ? link?.type?.outward : link?.type?.inward) || 'Linked',
      };
    })
    .filter(Boolean);
}

function normalizeTicket(issue) {
  const fields = issue?.fields || {};
  const renderedFields = issue?.renderedFields || {};
  const labels = Array.isArray(fields.labels) ? fields.labels : [];
  const components = Array.isArray(fields.components)
    ? fields.components.map((c) => c?.name).filter(Boolean)
    : [];
  const subtasks = Array.isArray(fields.subtasks) ? fields.subtasks : [];
  const attachments = Array.isArray(fields.attachment)
    ? fields.attachment
        .map((a) => ({ filename: a?.filename, url: a?.content }))
        .filter((a) => a.filename && a.url)
    : [];
  const comments = Array.isArray(fields?.comment?.comments)
    ? fields.comment.comments.map((c) => ({
        author: c?.author?.displayName || c?.author?.name || 'Unknown',
        body: normalizeCommentBody(c?.body),
        created: c?.created || '',
      }))
    : [];

  const ticket = {
    key: issue?.key || '',
    summary: fields?.summary || '',
    description: plainTextDescription(fields, renderedFields),
    ticketType: fields?.issuetype?.name || 'Unknown',
    priority: fields?.priority?.name || 'Medium',
    labels,
    components,
    componentCount: components.length,
    storyPoints: normalizeStoryPoints(fields),
    hasSubtasks: subtasks.length > 0,
    subtaskCount: subtasks.length,
    assignee: fields?.assignee?.displayName || fields?.assignee?.name || null,
    reporter: fields?.reporter?.displayName || fields?.reporter?.name || 'Unknown',
    status: fields?.status?.name || 'Unknown',
    created: fields?.created || '',
    attachments,
    comments,
    linkedIssues: normalizeLinkedIssues(fields?.issuelinks),
    forceProfile: normalizeForceProfile(fields, labels),
  };

  return ticket;
}

async function fetchIssue(ticketKey, credentials) {
  const auth = Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64');
  const url = `${credentials.baseUrl}/rest/api/2/issue/${encodeURIComponent(ticketKey)}?expand=renderedFields`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${auth}`,
    },
  });

  if (response.status === 404) {
    throw new Error(`Ticket ${ticketKey} not found`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Jira authentication failed — check JIRA_EMAIL and JIRA_API_TOKEN');
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch Jira ticket ${ticketKey}: HTTP ${response.status}${text ? ` - ${text}` : ''}`);
  }

  return response.json();
}

export async function run(context) {
  context.state.stageStart(STAGE_NAME);
  context.logger.log({
    type: 'STAGE_STARTED',
    stage: STAGE_NAME,
  });

  const ticketKey = context?.ticketKey;
  if (!ticketKey || typeof ticketKey !== 'string') {
    throw new Error('context.ticketKey is required');
  }

  const credentials = requireEnvVars();
  const issue = await fetchIssue(ticketKey, credentials);
  const ticket = normalizeTicket(issue);

  context.state.checkpoint(STAGE_NAME, ticket);
  context.logger.log({
    type: 'STAGE_COMPLETED',
    stage: STAGE_NAME,
  });

  return ticket;
}
