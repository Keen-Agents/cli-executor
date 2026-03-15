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
/**
 * Kill a bridge session by ID. Safe to call if session already dead.
 */
export async function killSession(sessionId) {
    if (!sessionId) return;
    try { await bridgeCall('/api/cli/kill', { sessionId }); } catch {}
}

export async function runAgent(opts) {
    const timeout = opts?.timeout ?? DEFAULT_TIMEOUT;
    const pollInterval = opts?.pollInterval ?? DEFAULT_POLL_INTERVAL;
    const extractRegex = 'extractRegex' in (opts || {}) ? opts.extractRegex : DEFAULT_EXTRACT_REGEX;
    const extraArgs = Array.isArray(opts?.extraArgs) ? opts.extraArgs : [];
    const cli = String(opts?.cli || '').toLowerCase();
    const prompt = String(opts?.prompt || '');
    const signal = opts?.signal || null;

    if (!cli) {
        throw new Error("runAgent requires 'cli'");
    }
    if (!prompt) {
        throw new Error("runAgent requires 'prompt'");
    }

    // Pre-flight: if already aborted, don't even spawn
    if (signal?.aborted) {
        return {
            success: false, content: null, fullOutput: '', rawStdout: '', rawStderr: '',
            sessionId: null, pid: null, durationMs: 0, exitCode: null, parsedJson: null, timedOut: true
        };
    }

    const metadata = {
        ...(opts?.metadata || {}),
        ...(opts?.label ? { label: opts.label } : {})
    };

    const args = buildArgs(cli, prompt, extraArgs);

    // Both CLIs read prompt from stdin to avoid ENAMETOOLONG on long prompts:
    // - Claude: `-p` with no positional prompt arg reads from stdin
    // - Codex: `exec -` reads from stdin
    const stdinData = prompt;

    const spawnResult = await bridgeCall('/api/cli/spawn', {
        cli,
        args,
        cwd: opts?.cwd,
        closeStdin: true,
        ...(stdinData ? { stdinData } : {}),
        metadata
    });

    const sessionId = spawnResult?.sessionId || null;
    const pid = spawnResult?.pid ?? null;
    if (!sessionId) {
        throw new Error('Bridge spawn did not return a sessionId');
    }
    const startTime = Date.now();

    while (true) {
        // Check abort signal before each poll
        if (signal?.aborted) {
            await bridgeCall('/api/cli/kill', { sessionId }).catch(() => {});
            return {
                success: false, content: null, fullOutput: '', rawStdout: '', rawStderr: '',
                sessionId, pid, durationMs: Date.now() - startTime, exitCode: null, parsedJson: null, timedOut: true
            };
        }

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
        let userInput = null;
        let modelOutput = null;

        if (cli === 'claude') {
            const claudeParsed = parseClaudeStdout(rawStdout);
            parsedJson = claudeParsed.parsedJson;
            fullOutput = claudeParsed.fullOutput;
            modelOutput = fullOutput;
        } else if (cli === 'codex') {
            const codexParsed = parseCodexJsonl(rawStdout);
            parsedJson = codexParsed.parsedJson;
            fullOutput = codexParsed.fullOutput;
            userInput = codexParsed.userInput;
            modelOutput = codexParsed.modelOutput;
        }

        const match = extractRegex ? fullOutput.match(extractRegex) : null;
        const content = match ? (match[1] || '').trim() : null;
        const success = exitCode === 0 && (!extractRegex || !!match);

        return {
            success,
            content,
            fullOutput,
            userInput,
            modelOutput,
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
        // NOTE: --output-format stream-json would give real-time NDJSON but deadlocks
        // on Windows with large stdin prompts (pipe buffer contention). Stick with
        // plain -p which outputs text. The bridge parseClaudeStreamJson is available
        // if stream-json is ever enabled via extraArgs for specific use cases.
        return ['-p', ...defaults, ...extraArgs];
    }
    if (cli === 'codex') {
        const defaults = AGENT_DEFAULTS.codex?.extraArgs || [];
        return ['exec', '--json', '-', ...defaults, ...extraArgs];
    }
    return [prompt, ...extraArgs];
}

/**
 * Parse Claude stdout — handles both legacy single-JSON and stream-json NDJSON.
 * @param {string} stdout
 * @returns {{ parsedJson: any, fullOutput: string }}
 */
function parseClaudeStdout(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed) {
        return { parsedJson: null, fullOutput: stdout };
    }

    // Legacy single-JSON format (no --output-format stream-json)
    if (trimmed.startsWith('{') && !trimmed.includes('\n')) {
        try {
            const parsedJson = JSON.parse(trimmed);
            const fullOutput = typeof parsedJson?.result === 'string' ? parsedJson.result : stdout;
            return { parsedJson, fullOutput };
        } catch {
            return { parsedJson: null, fullOutput: stdout };
        }
    }

    // Stream-JSON NDJSON format: multiple JSON lines
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    const events = [];
    const textParts = [];
    let resultObj = null;

    for (const line of lines) {
        try {
            const event = JSON.parse(line);
            events.push(event);

            // Extract text from assistant message events
            if (event.type === 'assistant' && event.message?.content) {
                for (const block of event.message.content) {
                    if (block.type === 'text' && typeof block.text === 'string') {
                        textParts.push(block.text);
                    }
                }
            }

            // Extract from result event (final output) — only if no assistant text yet
            if (event.type === 'result') {
                resultObj = event;
                if (textParts.length === 0 && typeof event.result === 'string') {
                    textParts.push(event.result);
                } else if (textParts.length === 0 && event.result?.content) {
                    for (const block of event.result.content) {
                        if (block.type === 'text' && typeof block.text === 'string') {
                            textParts.push(block.text);
                        }
                    }
                }
            }
        } catch {
            // Non-JSON line, skip
        }
    }

    if (events.length === 0) {
        // Fallback: try as single JSON blob
        try {
            const parsedJson = JSON.parse(trimmed);
            const fullOutput = typeof parsedJson?.result === 'string' ? parsedJson.result : stdout;
            return { parsedJson, fullOutput };
        } catch {
            return { parsedJson: null, fullOutput: stdout };
        }
    }

    const fullOutput = textParts.join('').trim() || stdout;
    return { parsedJson: resultObj || events, fullOutput };
}

/**
 * Parse Codex JSONL stdout and extract structured output.
 *
 * Returns fullOutput formatted with user input and model response separated,
 * similar to how parseClaudeStdout returns clean human-readable text.
 *
 * @param {string} stdout
 * @returns {{ parsedJson: any, fullOutput: string, userInput: string | null, modelOutput: string | null }}
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
        // No JSON found — try plain-text extraction (non --json mode)
        const plainText = extractCodexPlainText(stdout);
        return { parsedJson: null, fullOutput: plainText || stdout, userInput: null, modelOutput: null };
    }

    const userMessages = [];
    const assistantMessages = [];

    for (const event of parsedJson) {
        if (event?.type !== 'item.completed') {
            continue;
        }

        const item = event?.item;
        if (!item) continue;

        // Skip function_call and function_call_output events — not human-readable
        if (item.type === 'function_call' || item.type === 'function_call_output') {
            continue;
        }

        const role = item.role || item.type;
        const msg = extractAgentMessage(event);
        if (!msg) continue;

        if (role === 'user') {
            userMessages.push(msg);
        } else {
            assistantMessages.push(msg);
        }
    }

    const userInput = userMessages.length > 0 ? userMessages.join('\n\n') : null;
    const modelOutput = assistantMessages.length > 0 ? assistantMessages.join('\n\n') : null;

    // Build human-readable fullOutput
    let fullOutput;
    if (modelOutput) {
        fullOutput = modelOutput;
    } else if (userInput) {
        // No assistant output extracted — unusual, include user input as context
        fullOutput = userInput;
    } else {
        // Neither extracted — fall back to plain-text extraction from raw stdout
        fullOutput = extractCodexPlainText(stdout) || stdout;
    }

    return { parsedJson, fullOutput, userInput, modelOutput };
}

/**
 * Extract response text from plain-text Codex output (non --json mode).
 * Looks for the "codex" marker line and extracts text between it and "tokens used".
 *
 * @param {string} stdout
 * @returns {string | null}
 */
function extractCodexPlainText(stdout) {
    const lines = stdout.split('\n');
    let responseStart = -1;
    let responseEnd = lines.length;

    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim() === 'codex') { responseStart = i + 1; break; }
    }

    if (responseStart < 0) return null;

    for (let i = responseStart; i < lines.length; i++) {
        if (lines[i].trim() === 'tokens used') { responseEnd = i; break; }
    }

    const extracted = lines.slice(responseStart, responseEnd).join('\n').trim();
    return extracted || null;
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
