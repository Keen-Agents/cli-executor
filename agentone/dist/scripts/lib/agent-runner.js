import { BRIDGE_URL, API_TOKEN, DEFAULTS, AGENT_DEFAULTS } from '../pipeline-config.js';

const DEFAULT_TIMEOUT = DEFAULTS.stepTimeout;
const DEFAULT_POLL_INTERVAL = DEFAULTS.pollInterval;
const DEFAULT_EXTRACT_REGEX = DEFAULTS.completedRegex;

/**
 * Call the local bridge API.
 *
 * @param {string} endpoint
 * @param {object} body
 * @returns {Promise<any>}
 */
export async function bridgeCall(endpoint, body) {
    const response = await fetch(`${BRIDGE_URL}${endpoint}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-token': API_TOKEN
        },
        body: JSON.stringify(body || {})
    });

    const text = await response.text();

    if (!response.ok) {
        let errMsg = response.statusText;
        try { errMsg = JSON.parse(text).error || errMsg; } catch {}
        throw new Error(`Bridge error (${endpoint}): ${errMsg}`);
    }

    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`Bridge returned non-JSON response (${endpoint}): ${text.slice(0, 200)}`);
    }
}

/**
 * Run an agent via the local bridge spawn -> poll -> extract flow.
 *
 * @param {object} opts
 * @param {string} opts.cli
 * @param {string} opts.prompt
 * @param {string} [opts.cwd]
 * @param {string} [opts.label]
 * @param {object} [opts.metadata]
 * @param {number} [opts.timeout]
 * @param {number} [opts.pollInterval]
 * @param {RegExp} [opts.extractRegex]
 * @param {string[]} [opts.extraArgs]
 * @returns {Promise<{
 *   success: boolean,
 *   content: string | null,
 *   fullOutput: string,
 *   rawStdout: string,
 *   rawStderr: string,
 *   sessionId: string | null,
 *   pid: number | null,
 *   durationMs: number,
 *   exitCode: number | null,
 *   parsedJson: any,
 *   timedOut: boolean
 * }>}
 */
export async function runAgent(opts) {
    const timeout = opts?.timeout ?? DEFAULT_TIMEOUT;
    const pollInterval = opts?.pollInterval ?? DEFAULT_POLL_INTERVAL;
    const extractRegex = opts?.extractRegex ?? DEFAULT_EXTRACT_REGEX;
    const extraArgs = Array.isArray(opts?.extraArgs) ? opts.extraArgs : [];
    const cli = String(opts?.cli || '').toLowerCase();
    const prompt = String(opts?.prompt || '');

    if (!cli) {
        throw new Error("runAgent requires 'cli'");
    }
    if (!prompt) {
        throw new Error("runAgent requires 'prompt'");
    }

    const args = buildArgs(cli, prompt, extraArgs);
    const metadata = {
        ...(opts?.metadata || {}),
        ...(opts?.label ? { label: opts.label } : {})
    };

    const spawnResult = await bridgeCall('/api/cli/spawn', {
        cli,
        args,
        cwd: opts?.cwd,
        closeStdin: true,
        metadata
    });

    const sessionId = spawnResult?.sessionId || null;
    const pid = spawnResult?.pid ?? null;
    if (!sessionId) {
        throw new Error('Bridge spawn did not return a sessionId');
    }
    const startTime = Date.now();

    while (true) {
        const pollResult = await bridgeCall('/api/cli/poll', {
            sessionId,
            interval: pollInterval
        });

        // If the process finished, read results (even if we're past timeout)
        if (!pollResult?.running) {
            // fall through to result extraction below
        } else {
            // Still running — check timeout
            const elapsed = Date.now() - startTime;
            if (elapsed > timeout) {
                const partial = await bridgeCall('/api/cli/output', { sessionId, full: true }).catch(() => ({}));
                await bridgeCall('/api/cli/kill', { sessionId }).catch(() => {});

                return {
                    success: false,
                    content: null,
                    fullOutput: partial?.stdout || '',
                    rawStdout: partial?.stdout || '',
                    rawStderr: partial?.stderr || '',
                    sessionId,
                    pid,
                    durationMs: elapsed,
                    exitCode: null,
                    parsedJson: null,
                    timedOut: true
                };
            }
            continue;
        }

        const rawStdout = pollResult?.stdout || '';
        const rawStderr = pollResult?.stderr || '';
        const exitCode = pollResult?.exitCode ?? null;

        let parsedJson = null;
        let fullOutput = rawStdout;

        if (cli === 'claude') {
            const claudeParsed = parseClaudeStdout(rawStdout);
            parsedJson = claudeParsed.parsedJson;
            fullOutput = claudeParsed.fullOutput;
        } else if (cli === 'codex') {
            const codexParsed = parseCodexJsonl(rawStdout);
            parsedJson = codexParsed.parsedJson;
            fullOutput = codexParsed.fullOutput;
        }

        const match = extractRegex ? fullOutput.match(extractRegex) : null;
        const content = match ? (match[1] || '').trim() : null;
        const success = exitCode === 0 && (!extractRegex || !!match);

        return {
            success,
            content,
            fullOutput,
            rawStdout,
            rawStderr,
            sessionId,
            pid,
            durationMs: Date.now() - startTime,
            exitCode,
            parsedJson,
            timedOut: false
        };
    }
}

/**
 * @param {string} cli
 * @param {string} prompt
 * @param {string[]} extraArgs
 * @returns {string[]}
 */
function buildArgs(cli, prompt, extraArgs) {
    if (cli === 'claude') {
        const defaults = AGENT_DEFAULTS.claude?.extraArgs || [];
        return ['-p', prompt, ...defaults, ...extraArgs];
    }
    if (cli === 'codex') {
        const defaults = AGENT_DEFAULTS.codex?.extraArgs || [];
        return ['exec', '--sandbox', 'read-only', '--json', prompt, ...defaults, ...extraArgs];
    }
    return [prompt, ...extraArgs];
}

/**
 * @param {string} stdout
 * @returns {{ parsedJson: any, fullOutput: string }}
 */
function parseClaudeStdout(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed || !trimmed.startsWith('{')) {
        return { parsedJson: null, fullOutput: stdout };
    }

    try {
        const parsedJson = JSON.parse(trimmed);
        const fullOutput = typeof parsedJson?.result === 'string' ? parsedJson.result : stdout;
        return { parsedJson, fullOutput };
    } catch {
        return { parsedJson: null, fullOutput: stdout };
    }
}

/**
 * Parse Codex JSONL stdout and extract message text from item.completed events.
 *
 * @param {string} stdout
 * @returns {{ parsedJson: any, fullOutput: string }}
 */
function parseCodexJsonl(stdout) {
    const lines = stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

    /** @type {any[]} */
    const parsedJson = [];

    for (const line of lines) {
        try {
            parsedJson.push(JSON.parse(line));
        } catch {
            // ignore non-JSON lines, keep raw output fallback
        }
    }

    if (parsedJson.length === 0) {
        return { parsedJson: null, fullOutput: stdout };
    }

    const completedMessages = [];

    for (const item of parsedJson) {
        if (item?.type !== 'item.completed') {
            continue;
        }

        const msg = extractAgentMessage(item);
        if (msg) {
            completedMessages.push(msg);
        }
    }

    const fullOutput = completedMessages.length > 0 ? completedMessages.join('\n\n') : stdout;
    return { parsedJson, fullOutput };
}

/**
 * @param {any} event
 * @returns {string | null}
 */
function extractAgentMessage(event) {
    const direct =
        toText(event?.agent_message) ||
        toText(event?.item?.agent_message) ||
        toText(event?.item?.message);
    if (direct) {
        return direct;
    }

    const item = event?.item;
    if (item?.type === 'agent_message') {
        const contentText = contentToText(item?.content);
        if (contentText) {
            return contentText;
        }
    }

    return contentToText(item?.content);
}

/**
 * @param {any} value
 * @returns {string | null}
 */
function toText(value) {
    if (typeof value === 'string') {
        return value;
    }
    if (Array.isArray(value)) {
        const joined = value.map(v => (typeof v === 'string' ? v : '')).filter(Boolean).join('\n').trim();
        return joined || null;
    }
    if (value && typeof value === 'object') {
        if (typeof value.text === 'string') return value.text;
        if (typeof value.content === 'string') return value.content;
    }
    return null;
}

/**
 * @param {any} content
 * @returns {string | null}
 */
function contentToText(content) {
    if (typeof content === 'string') {
        return content;
    }

    if (!Array.isArray(content)) {
        return null;
    }

    const parts = [];
    for (const chunk of content) {
        if (typeof chunk === 'string') {
            parts.push(chunk);
            continue;
        }
        if (!chunk || typeof chunk !== 'object') {
            continue;
        }

        if (typeof chunk.text === 'string') {
            parts.push(chunk.text);
        } else if (typeof chunk.content === 'string') {
            parts.push(chunk.content);
        } else if (typeof chunk.output_text === 'string') {
            parts.push(chunk.output_text);
        }
    }

    const joined = parts.join('\n').trim();
    return joined || null;
}
