import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const STAGE_NAME = 'intake';
const FORCE_PROFILES = new Set(['force-simple', 'force-standard', 'force-complex']);
const WORKDIR_ENV_KEYS = ['AGENTONE_WORKDIR', 'PIPELINE_WORKDIR', 'WORKING_DIRECTORY'];
const WORKDIR_MAP_ENV_KEYS = ['AGENTONE_WORKDIR_MAP', 'PIPELINE_WORKDIR_MAP'];

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

function normalizeTicket(issue, workingDirectory, repo = null, baseBranch = null) {
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
    projectKey: typeof issue?.key === 'string' && issue.key.includes('-') ? issue.key.split('-')[0] : '',
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
    repo,
    baseBranch,
    workingDirectory: workingDirectory ? path.resolve(workingDirectory) : null,
  };

  return ticket;
}

function parseJsonEnv(keys) {
  for (const key of keys) {
    const raw = process.env[key];
    if (!raw || !raw.trim()) continue;

    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch (error) {
      throw new Error(`${key} must contain valid JSON. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return null;
}

function resolveMappedPath(ticket) {
  const map = parseJsonEnv(WORKDIR_MAP_ENV_KEYS);
  if (!map) {
    return null;
  }

  const labelKeys = Array.isArray(ticket?.labels)
    ? ticket.labels
        .filter((label) => typeof label === 'string' && label.trim())
        .map((label) => `label:${label}`)
    : [];
  const componentKeys = Array.isArray(ticket?.components)
    ? ticket.components
        .filter((component) => typeof component === 'string' && component.trim())
        .map((component) => `component:${component}`)
    : [];

  const candidates = [
    ticket?.key,
    ticket?.projectKey,
    ...labelKeys,
    ...componentKeys,
    'default'
  ].filter(Boolean);

  for (const key of candidates) {
    const value = map[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function resolveWorkingDirectory(issue, ticket, context) {
  const fields = issue?.fields || {};
  const directFieldCandidates = [
    fields.workingDirectory,
    fields.repoPath,
    fields.repositoryPath,
    fields.localPath
  ];

  for (const envKey of WORKDIR_ENV_KEYS) {
    const value = process.env[envKey];
    if (typeof value === 'string' && value.trim()) {
      return path.resolve(value.trim());
    }
  }

  const mapped = resolveMappedPath(ticket);
  if (mapped) {
    return path.resolve(mapped);
  }

  for (const candidate of directFieldCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return path.resolve(candidate.trim());
    }
  }

  const contextCandidate = context?.workingDirectory || context?.workDir || context?.state?.getWorkingDirectory?.();
  if (typeof contextCandidate === 'string' && contextCandidate.trim()) {
    return path.resolve(contextCandidate.trim());
  }

  if (process.env.AGENTONE_ALLOW_CWD_FALLBACK === '1') {
    return process.cwd();
  }

  return null;
}

function runGit(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch {
    return '';
  }
}

function resolveRepoMetadata(workingDirectory) {
  if (!workingDirectory) {
    return { repo: null, baseBranch: null };
  }

  const repo = process.env.AGENTONE_REPO
    || process.env.PIPELINE_REPO
    || runGit(['remote', 'get-url', 'origin'], workingDirectory)
    || null;

  const remoteHead = runGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], workingDirectory);
  const inferredBaseBranch = remoteHead.includes('/')
    ? remoteHead.split('/').slice(-1)[0]
    : '';
  const baseBranch = process.env.AGENTONE_BASE_BRANCH
    || process.env.PIPELINE_BASE_BRANCH
    || inferredBaseBranch
    || 'main';

  return {
    repo: typeof repo === 'string' && repo.trim() ? repo.trim() : null,
    baseBranch: typeof baseBranch === 'string' && baseBranch.trim() ? baseBranch.trim() : null
  };
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

function hasJiraCredentials() {
  return Boolean(
    process.env.JIRA_BASE_URL?.trim() &&
    process.env.JIRA_EMAIL?.trim() &&
    process.env.JIRA_API_TOKEN?.trim()
  );
}

function buildPromptTicket(ticketKey, promptText, workingDirectory, repo, baseBranch) {
  const lines = promptText.split('\n').filter(Boolean);
  const summary = lines[0]?.slice(0, 200) || 'General task';
  const description = promptText;

  return {
    key: ticketKey,
    projectKey: ticketKey.includes('-') ? ticketKey.split('-')[0] : 'TASK',
    summary,
    description,
    ticketType: 'Task',
    priority: 'Medium',
    labels: [],
    components: [],
    componentCount: 0,
    storyPoints: null,
    hasSubtasks: false,
    subtaskCount: 0,
    assignee: null,
    reporter: 'pipeline',
    status: 'Open',
    created: new Date().toISOString(),
    attachments: [],
    comments: [],
    linkedIssues: [],
    forceProfile: null,
    repo,
    baseBranch,
    workingDirectory: workingDirectory ? path.resolve(workingDirectory) : null,
    source: 'prompt',
  };
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

  const promptText = context?.promptText || '';
  // promptText takes precedence — if the user passed --prompt, use prompt mode
  // regardless of whether Jira credentials happen to be set
  const isPromptMode = Boolean(promptText);

  let ticket;

  if (isPromptMode) {
    // Prompt mode — no Jira, build synthetic ticket from text
    const workingDirectory = resolveWorkingDirectory({}, { key: ticketKey, projectKey: 'TASK' }, context);
    if (!workingDirectory) {
      throw new Error(
        'Prompt mode requires a working directory. Use --workdir or set AGENTONE_WORKDIR.'
      );
    }
    if (!fs.existsSync(workingDirectory)) {
      throw new Error(`Working directory does not exist: ${workingDirectory}`);
    }

    const repoMetadata = resolveRepoMetadata(workingDirectory);
    ticket = buildPromptTicket(ticketKey, promptText, workingDirectory, repoMetadata.repo, repoMetadata.baseBranch);

    if (typeof context.state?.setWorkingDirectory === 'function') {
      context.state.setWorkingDirectory(workingDirectory, { base: true });
    }

    console.log(`[intake] Prompt mode — task "${ticket.summary}" in ${workingDirectory}`);
  } else {
    // Jira mode — fetch ticket from Jira API
    const credentials = requireEnvVars();
    const issue = await fetchIssue(ticketKey, credentials);
    const partialTicket = normalizeTicket(issue, null);
    const workingDirectory = resolveWorkingDirectory(issue, partialTicket, context);
    if (!workingDirectory) {
      throw new Error(
        'Unable to resolve a working directory for this ticket. Set AGENTONE_WORKDIR, PIPELINE_WORKDIR, or AGENTONE_WORKDIR_MAP.'
      );
    }
    if (!fs.existsSync(workingDirectory)) {
      throw new Error(`Resolved working directory does not exist: ${workingDirectory}`);
    }

    const repoMetadata = resolveRepoMetadata(workingDirectory);
    ticket = normalizeTicket(issue, workingDirectory, repoMetadata.repo, repoMetadata.baseBranch);
    if (typeof context.state?.setWorkingDirectory === 'function') {
      context.state.setWorkingDirectory(workingDirectory, { base: true });
    }
  }

  context.state.checkpoint(STAGE_NAME, ticket);
  context.logger.log({
    type: 'STAGE_COMPLETED',
    stage: STAGE_NAME,
  });

  return ticket;
}
