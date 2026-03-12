// CLI Executor Tool
// Allows agents to spawn and interact with CLI tools (claude, codex, etc.)
// on the local PC via the bridge wrapper's session-based API.

const BRIDGE_URL = 'https://pc.tail7c837c.ts.net';
const API_TOKEN = 'b3d6d5c1a50155e207c503102f7bc610';

async function bridgeCall(endpoint, body) {
    const response = await fetch(`${BRIDGE_URL}${endpoint}?token=${API_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-token': API_TOKEN, 'Authorization': `Bearer ${API_TOKEN}` },
        body: JSON.stringify(body)
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(`Bridge error (${endpoint}): ${err.error || response.statusText}`);
    }
    return response.json();
}

export async function exec() {
    const ctx = dictionary.TOOL_CONTEXT || dictionary;
    const mode = ctx.mode || 'execute';
    const cli = ctx.cli;
    const prompt = ctx.prompt;
    const args = ctx.args;
    const cwd = ctx.workingDirectory || ctx.cwd;
    const sessionId = ctx.sessionId;
    const input = ctx.input;
    const timeout = ctx.timeout || 300000;
    const planMode = ctx.planMode || false;

    const metadata = {
        pipelineRunId: ctx.pipelineRunId || null,
        agentType: ctx.agentType || null,
        subtaskId: ctx.subtaskId || null,
        parentSessionId: ctx.parentSessionId || null,
        label: ctx.label || null
    };

    try {
        if (mode === 'execute') {
            if (!cli) throw new Error("Missing 'cli' parameter (e.g. 'claude')");

            let cliArgs = [];
            if (args) {
                if (typeof args === 'string') {
                    try { cliArgs = JSON.parse(args); } catch { cliArgs = args.split(' '); }
                } else {
                    cliArgs = args;
                }
            } else if (prompt) {
                if (cli === 'claude') {
                    const allowedTools = ctx.allowedTools || 'Bash,Edit,Read,Write,Grep,Glob,WebSearch,WebFetch';
                    cliArgs = ['-p', prompt, '--allowedTools', allowedTools, '--output-format', 'json'];
                    if (planMode) {
                        cliArgs.push('--permission-mode', 'plan');
                    }
                } else {
                    cliArgs = [prompt];
                }
            }

            const spawnResult = await bridgeCall('/api/cli/spawn', {
                cli, args: cliArgs, cwd, closeStdin: true, metadata
            });

            const POLL_INTERVAL = 3000;
            const startTime = Date.now();
            let pollResult;

            while (true) {
                pollResult = await bridgeCall('/api/cli/poll', {
                    sessionId: spawnResult.sessionId,
                    interval: POLL_INTERVAL
                });

                if (!pollResult.running) break;

                // Detect human-gate pause — return early so the agent can ask the user
                const partialOut = pollResult.stdout || '';
                if (partialOut.includes('[human-gate] Pipeline paused')) {
                    const runIdMatch = partialOut.match(/Starting run (run-[^\s]+)/);
                    const runId = runIdMatch ? runIdMatch[1] : 'unknown';
                    dictionary.response = `PIPELINE_PAUSED_FOR_REVIEW\n\nThe pipeline is paused at the human-gate stage waiting for your approval.\nRun ID: ${runId}\nSession ID: ${spawnResult.sessionId}\n\nPlease ask the user to approve, revise, or reject.\nTo approve, call CLI Executor with:\n  mode: execute\n  cli: node\n  args: ["-e", "fetch('http://localhost:3222/api/pipeline/decide',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'${runId}',decision:'approve',comments:''})}).then(r=>r.json()).then(j=>console.log(JSON.stringify(j))).catch(e=>console.error(e))"]\n\nAfter approving, resume the pipeline by calling CLI Executor with:\n  mode: wait\n  sessionId: ${spawnResult.sessionId}\n  timeout: 900000`;
                    return;
                }

                const elapsed = Date.now() - startTime;
                if (elapsed > timeout) {
                    await bridgeCall('/api/cli/kill', { sessionId: spawnResult.sessionId }).catch(() => {});
                    dictionary.response = `CLI timed out after ${Math.round(timeout / 1000)}s.\n\nPartial output:\n${pollResult.stdout || '(no output)'}`;
                    return;
                }
            }

            await bridgeCall('/api/cli/cleanup', {}).catch(() => {});

            let output = pollResult.stdout || '';

            if (cli === 'claude' && output.trim().startsWith('{')) {
                try {
                    const parsed = JSON.parse(output);
                    output = parsed.result || output;
                    if (parsed) dictionary.conversationHistory = parsed;
                } catch {
                    // not JSON, use raw
                }
            }

            if (pollResult.stderr) output += `\n[STDERR]\n${pollResult.stderr}`;
            if (pollResult.exitCode !== 0) output += `\n[EXIT CODE: ${pollResult.exitCode}]`;

            dictionary.response = output || '(CLI completed with no output)';
        }

        else if (mode === 'spawn') {
            if (!cli) throw new Error("Missing 'cli' parameter");

            let cliArgs = [];
            if (args) {
                if (typeof args === 'string') {
                    try { cliArgs = JSON.parse(args); } catch { cliArgs = args.split(' '); }
                } else {
                    cliArgs = args;
                }
            }

            const result = await bridgeCall('/api/cli/spawn', { cli, args: cliArgs, cwd, metadata });

            dictionary.response = JSON.stringify({
                sessionId: result.sessionId,
                pid: result.pid,
                status: 'running',
                message: `CLI session started: ${cli}`
            });
        }

        else if (mode === 'send') {
            if (!sessionId) throw new Error("Missing 'sessionId' for send mode");
            if (!input) throw new Error("Missing 'input' for send mode");

            await bridgeCall('/api/cli/send', { sessionId, input });
            dictionary.response = `Input sent to session ${sessionId}`;
        }

        else if (mode === 'read') {
            if (!sessionId) throw new Error("Missing 'sessionId' for read mode");

            const result = await bridgeCall('/api/cli/output', { sessionId, full: ctx.full || false });

            let output = result.stdout || '';
            if (result.stderr) output += `\n[STDERR]\n${result.stderr}`;
            if (!result.running) output += `\n[EXITED: code ${result.exitCode}]`;

            dictionary.response = output || '(no new output)';
        }

        else if (mode === 'wait') {
            if (!sessionId) throw new Error("Missing 'sessionId' for wait mode");

            const POLL_INTERVAL = 3000;
            const startTime = Date.now();
            let pollResult;

            while (true) {
                pollResult = await bridgeCall('/api/cli/poll', { sessionId, interval: POLL_INTERVAL });
                if (!pollResult.running) break;

                const elapsed = Date.now() - startTime;
                if (elapsed > timeout) {
                    let output = pollResult.stdout || '';
                    if (pollResult.stderr) output += `\n[STDERR]\n${pollResult.stderr}`;
                    output += `\n[TIMED OUT after ${Math.round(timeout / 1000)}s]`;
                    dictionary.response = output;
                    return;
                }
            }

            let output = pollResult.stdout || '';
            if (pollResult.stderr) output += `\n[STDERR]\n${pollResult.stderr}`;
            output += `\n[EXIT CODE: ${pollResult.exitCode}]`;
            dictionary.response = output;
        }

        else if (mode === 'kill') {
            if (!sessionId) throw new Error("Missing 'sessionId' for kill mode");
            await bridgeCall('/api/cli/kill', { sessionId });
            dictionary.response = `Session ${sessionId} killed`;
        }

        else {
            throw new Error(`Unknown mode: ${mode}. Use: execute, spawn, send, read, wait, kill`);
        }

    } catch (error) {
        dictionary.response = `CLI Executor Error: ${error.message}`;
    }
}
