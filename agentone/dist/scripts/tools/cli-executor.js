// CLI Executor Tool
// Allows agents to spawn and interact with CLI tools (claude, codex, etc.)
// on the local PC via the bridge wrapper's session-based API.
//
// Modes:
//   "execute"     — Spawn CLI, wait for it to finish, return full output (one-shot)
//   "spawn"       — Start a CLI session, return sessionId for interactive use
//   "send"        — Send input to a running session
//   "read"        — Read output from a running session
//   "wait"        — Wait for session to finish
//   "kill"        — Kill a running session

const BRIDGE_URL = process.env.AGENTONE_BRIDGE_URL || process.env.BRIDGE_URL || 'http://localhost:3222';
const API_TOKEN = process.env.AGENTONE_API_TOKEN || process.env.BRIDGE_API_TOKEN || '';

async function bridgeCall(endpoint, body) {
    const response = await fetch(`${BRIDGE_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-token': API_TOKEN },
        body: JSON.stringify(body)
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(`Bridge error (${endpoint}): ${err.error || response.statusText}`);
    }
    return response.json();
}

export async function exec() {
    const mode = dictionary.mode || 'execute';
    const cli = dictionary.cli;
    const prompt = dictionary.prompt;
    const args = dictionary.args;
    const cwd = dictionary.workingDirectory || dictionary.cwd;
    const sessionId = dictionary.sessionId;
    const input = dictionary.input;
    const timeout = dictionary.timeout || 300000;
    const planMode = dictionary.planMode || false;

    const metadata = {
        pipelineRunId: dictionary.pipelineRunId || null,
        agentType: dictionary.agentType || null,
        subtaskId: dictionary.subtaskId || null,
        parentSessionId: dictionary.parentSessionId || null,
        label: dictionary.label || null
    };

    writeThinking(`CLI Executor: mode=${mode}, cli=${cli || '(none)'}, agent=${metadata.agentType || '-'}, subtask=${metadata.subtaskId || '-'}`);

    try {
        if (mode === 'execute') {
            if (!cli) throw new Error("Missing 'cli' parameter (e.g. 'claude')");

            let cliArgs = [];
            if (args) {
                cliArgs = typeof args === 'string' ? args.split(' ') : args;
            } else if (prompt) {
                if (cli === 'claude') {
                    const allowedTools = dictionary.allowedTools || 'Bash,Edit,Read,Write,Grep,Glob,WebSearch,WebFetch';
                    cliArgs = ['-p', prompt, '--allowedTools', allowedTools, '--output-format', 'json'];
                    if (planMode) {
                        cliArgs.push('--permission-mode', 'plan');
                        writeThinking('Plan mode enabled');
                    }
                } else {
                    cliArgs = [prompt];
                }
            }

            writeThinking(`Spawning: ${cli} ${cliArgs.join(' ')}`);
            writeThinking(`Working directory: ${cwd || '(bridge default)'}`);

            const spawnResult = await bridgeCall('/api/cli/spawn', {
                cli, args: cliArgs, cwd, closeStdin: true, metadata
            });

            writeThinking(`Session ${spawnResult.sessionId} started (pid: ${spawnResult.pid})`);

            const POLL_INTERVAL = 3000;
            const startTime = Date.now();
            let pollResult;

            while (true) {
                pollResult = await bridgeCall('/api/cli/poll', {
                    sessionId: spawnResult.sessionId,
                    interval: POLL_INTERVAL
                });

                if (!pollResult.running) {
                    writeThinking(`CLI exited with code ${pollResult.exitCode} after ${Math.round((Date.now() - startTime) / 1000)}s`);
                    break;
                }

                const elapsed = Date.now() - startTime;
                if (elapsed > timeout) {
                    writeThinking(`Session timed out after ${Math.round(timeout / 1000)}s, killing...`);
                    await bridgeCall('/api/cli/kill', { sessionId: spawnResult.sessionId }).catch(() => {});
                    dictionary.response = `CLI timed out after ${Math.round(timeout / 1000)}s.\n\nPartial output:\n${pollResult.stdout || '(no output)'}`;
                    return;
                }

                writeThinking(`Still running... (${Math.round(elapsed / 1000)}s elapsed)`);
            }

            await bridgeCall('/api/cli/cleanup', {}).catch(() => {});

            let output = pollResult.stdout || '';
            let structuredHistory = null;

            if (cli === 'claude' && output.trim().startsWith('{')) {
                try {
                    const parsed = JSON.parse(output);
                    structuredHistory = parsed;
                    output = parsed.result || output;
                    if (parsed.usage) {
                        writeThinking(`Usage: input=${parsed.usage.input_tokens || 0}, output=${parsed.usage.output_tokens || 0}`);
                    }
                } catch {
                    writeThinking('Could not parse Claude JSON output, using raw stdout');
                }
            }

            if (pollResult.stderr) output += `\n[STDERR]\n${pollResult.stderr}`;
            if (pollResult.exitCode !== 0) output += `\n[EXIT CODE: ${pollResult.exitCode}]`;

            dictionary.response = output || '(CLI completed with no output)';
            if (structuredHistory) dictionary.conversationHistory = structuredHistory;

            writeThinking(`Execution complete. Exit code: ${pollResult.exitCode}`);
            writeThinking(`Output length: ${output.length} chars`);
            writeThinking(`Output preview: ${output.substring(0, 500)}`);
        }

        else if (mode === 'spawn') {
            if (!cli) throw new Error("Missing 'cli' parameter");

            let cliArgs = [];
            if (args) cliArgs = typeof args === 'string' ? args.split(' ') : args;

            const result = await bridgeCall('/api/cli/spawn', { cli, args: cliArgs, cwd, metadata });

            dictionary.response = JSON.stringify({
                sessionId: result.sessionId,
                pid: result.pid,
                status: 'running',
                message: `CLI session started: ${cli}`
            });
            writeThinking(`Interactive session ${result.sessionId} started`);
        }

        else if (mode === 'send') {
            if (!sessionId) throw new Error("Missing 'sessionId' for send mode");
            if (!input) throw new Error("Missing 'input' for send mode");

            await bridgeCall('/api/cli/send', { sessionId, input });
            dictionary.response = `Input sent to session ${sessionId}`;
        }

        else if (mode === 'read') {
            if (!sessionId) throw new Error("Missing 'sessionId' for read mode");

            const result = await bridgeCall('/api/cli/output', { sessionId, full: dictionary.full || false });

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
                writeThinking(`Waiting... (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`);
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
        const msg = `CLI Executor Error: ${error.message}`;
        writeThinking(msg);
        dictionary.response = msg;
    }
}
