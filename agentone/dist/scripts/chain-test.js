// Two-Step Agent Chain Test
// Validates the spawn → poll → regex → chain pattern from Vic's diagram.
// Agent 1 creates a joke file, Agent 2 reads it back.
// Runs standalone (node chain-test.js) or as a Keen flow script.

import { mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const IS_KEEN = typeof dictionary !== 'undefined';

const runLog = [];

const log = IS_KEEN
    ? (msg) => { runLog.push({ t: Date.now(), type: 'debug', msg }); writeThinking(msg); }
    : (msg) => { runLog.push({ t: Date.now(), type: 'debug', msg }); console.log(`[${new Date().toISOString()}] ${msg}`); };

const output = IS_KEEN
    ? (msg) => { runLog.push({ t: Date.now(), type: 'output', msg }); writeOut(msg); }
    : (msg) => { runLog.push({ t: Date.now(), type: 'output', msg }); console.log(msg); };

const BRIDGE_URL = 'http://localhost:3222';
const API_TOKEN = 'b3d6d5c1a50155e207c503102f7bc610';
const POLL_INTERVAL = 3000;
const STEP_TIMEOUT = 120_000;
const COMPLETED_REGEX = /<COMPLETED>([\s\S]*?)<\/COMPLETED>/;
const SCRIPT_DIR = IS_KEEN ? process.cwd() : dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = resolve(SCRIPT_DIR, '..', '..', 'logs', 'chain-runs');

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

async function spawnAndWaitForCompleted(prompt, label, cwd) {
    log(`[${label}] Spawning Claude...`);
    log(`[${label}] Prompt: ${prompt.substring(0, 100)}...`);

    const spawnOpts = {
        cli: 'claude',
        args: ['-p', prompt, '--output-format', 'json', '--dangerously-skip-permissions'],
        closeStdin: true,
        metadata: { label, agentType: 'ChainTest', pipelineRunId: 'chain-test' }
    };
    if (cwd) spawnOpts.cwd = cwd;

    const spawnResult = await bridgeCall('/api/cli/spawn', spawnOpts);

    const { sessionId, pid } = spawnResult;
    log(`[${label}] Session ${sessionId} started (pid: ${pid})`);

    const startTime = Date.now();

    while (true) {
        const pollResult = await bridgeCall('/api/cli/poll', {
            sessionId,
            interval: POLL_INTERVAL
        });

        const elapsed = Date.now() - startTime;

        if (!pollResult.running) {
            log(`[${label}] Exited (code ${pollResult.exitCode}) after ${Math.round(elapsed / 1000)}s`);

            const stdout = pollResult.stdout || '';
            let resultText = stdout;
            let parsedJson = null;

            if (stdout.trim().startsWith('{')) {
                try {
                    parsedJson = JSON.parse(stdout);
                    resultText = parsedJson.result || stdout;
                    if (parsedJson.usage) {
                        log(`[${label}] Tokens: in=${parsedJson.usage.input_tokens || 0}, out=${parsedJson.usage.output_tokens || 0}`);
                    }
                    if (parsedJson.total_cost_usd) {
                        log(`[${label}] Cost: $${parsedJson.total_cost_usd.toFixed(4)}`);
                    }
                } catch {
                    log(`[${label}] Could not parse JSON, using raw stdout`);
                }
            }

            const base = { sessionId, pid, label, prompt, durationMs: elapsed, exitCode: pollResult.exitCode, rawStdout: stdout, rawStderr: pollResult.stderr || '', parsedJson };

            if (pollResult.exitCode !== 0) {
                log(`[${label}] Non-zero exit code. Stderr: ${(pollResult.stderr || '').substring(0, 200)}`);
                return { ...base, success: false, content: null, fullOutput: resultText, error: pollResult.stderr };
            }

            const match = resultText.match(COMPLETED_REGEX);
            if (match) {
                const content = match[1].trim();
                log(`[${label}] <COMPLETED> found: ${content.substring(0, 100)}`);
                return { ...base, success: true, content, fullOutput: resultText };
            }

            log(`[${label}] No <COMPLETED> tag in output`);
            log(`[${label}] Output: ${resultText.substring(0, 300)}`);
            return { ...base, success: false, content: null, fullOutput: resultText };
        }

        if (elapsed > STEP_TIMEOUT) {
            log(`[${label}] TIMEOUT after ${Math.round(STEP_TIMEOUT / 1000)}s, killing...`);
            await bridgeCall('/api/cli/kill', { sessionId }).catch(() => {});
            return { sessionId, pid, label, prompt, durationMs: elapsed, exitCode: null, rawStdout: pollResult.stdout || '', rawStderr: '', parsedJson: null, success: false, content: null, fullOutput: pollResult.stdout || '', timedOut: true };
        }

        log(`[${label}] Running... (${Math.round(elapsed / 1000)}s)`);
    }
}

async function runChain() {
    output('\n========================================');
    output('  Two-Step Agent Chain Test');
    output('========================================\n');

    const runStarted = Date.now();

    // Create shared test directory
    const workDir = resolve(SCRIPT_DIR, '..', 'test-chain');
    try { mkdirSync(workDir, { recursive: true }); } catch {}
    output(`[Setup] Working directory: ${workDir}\n`);

    // Step 1: Create the joke file
    output('[Step 1] Spawning Agent 1 — Create joke file...\n');

    const step1 = await spawnAndWaitForCompleted(
        'Create a file called joke.txt in the current directory containing a short original joke. After you are done, output exactly this format: <COMPLETED>TASK: created joke.txt with a joke</COMPLETED>',
        'Step1-CreateJoke',
        workDir
    );

    if (!step1.success) {
        output(`[Step 1] FAILED — ${step1.timedOut ? 'timed out' : 'no <COMPLETED> tag'}`);
        output(`Partial output: ${step1.fullOutput.substring(0, 300)}`);
        saveArchive({ runStarted, success: false, failedAt: 'Step1', steps: [step1] });
        if (IS_KEEN) { dictionary.response = 'Chain failed at Step 1'; dictionary.chainSuccess = false; }
        return;
    }

    output(`[Step 1] PASSED — ${step1.content}\n`);

    // Regex gate
    output('[Regex Check] <COMPLETED> detected → spawning Step 2\n');

    // Step 2: Read the joke file
    output('[Step 2] Spawning Agent 2 — Read joke file...\n');

    const step2 = await spawnAndWaitForCompleted(
        'Read the file called joke.txt in the current directory. Output the contents of the file in exactly this format: <COMPLETED>TASK: [paste the exact file contents here]</COMPLETED>',
        'Step2-ReadJoke',
        workDir
    );

    if (!step2.success) {
        output(`[Step 2] FAILED — ${step2.timedOut ? 'timed out' : 'no <COMPLETED> tag'}`);
        output(`Partial output: ${step2.fullOutput.substring(0, 300)}`);
        saveArchive({ runStarted, success: false, failedAt: 'Step2', steps: [step1, step2] });
        if (IS_KEEN) { dictionary.response = 'Chain failed at Step 2'; dictionary.chainSuccess = false; }
        return;
    }

    output(`[Step 2] PASSED — ${step2.content}\n`);

    // Extract the joke
    output('[Regex Check] <COMPLETED> detected → extracting result\n');

    const jokeMatch = step2.content.match(/^TASK:\s*([\s\S]*)$/i);
    const joke = jokeMatch ? jokeMatch[1].trim() : step2.content;

    output('========================================');
    output('  CHAIN COMPLETE');
    output('========================================');
    output(`\n  The joke:\n  "${joke}"\n`);

    saveArchive({ runStarted, success: true, finalResult: joke, steps: [step1, step2] });

    if (IS_KEEN) {
        dictionary.response = joke;
        dictionary.chainSuccess = true;
        dictionary.step1Result = step1.content;
        dictionary.step2Result = step2.content;
    }
}

function saveArchive(run) {
    try {
        mkdirSync(LOGS_DIR, { recursive: true });
        const ts = new Date(run.runStarted).toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
        const totalMs = Date.now() - run.runStarted;
        const totalCost = run.steps.reduce((sum, s) => sum + (s.parsedJson?.total_cost_usd || 0), 0);

        const archive = {
            timestamp: new Date(run.runStarted).toISOString(),
            durationMs: totalMs,
            success: run.success,
            failedAt: run.failedAt || null,
            finalResult: run.finalResult || null,
            totalCostUsd: totalCost,
            steps: run.steps.map(s => ({
                label: s.label,
                sessionId: s.sessionId,
                pid: s.pid,
                prompt: s.prompt,
                durationMs: s.durationMs,
                exitCode: s.exitCode,
                success: s.success,
                timedOut: s.timedOut || false,
                content: s.content,
                fullOutput: s.fullOutput,
                rawStdout: s.rawStdout,
                rawStderr: s.rawStderr,
                tokens: s.parsedJson?.usage || null,
                costUsd: s.parsedJson?.total_cost_usd || null,
                numTurns: s.parsedJson?.num_turns || null,
                claudeSessionId: s.parsedJson?.session_id || null
            })),
            log: runLog
        };

        const filename = `${ts}_${run.success ? 'OK' : 'FAIL'}.json`;
        const filepath = resolve(LOGS_DIR, filename);
        writeFileSync(filepath, JSON.stringify(archive, null, 2));
        output(`[Archive] Saved to ${filepath}`);
    } catch (err) {
        log(`[Archive] Failed to save: ${err.message}`);
    }
}

export async function exec() {
    try {
        await runChain();
    } catch (error) {
        log(`Chain error: ${error.message}`);
        output(`\nFATAL: ${error.message}`);
        saveArchive({ runStarted: Date.now(), success: false, failedAt: 'fatal', steps: [], finalResult: error.message });
        if (IS_KEEN) { dictionary.response = `Chain error: ${error.message}`; dictionary.chainSuccess = false; }
    }
}

if (!IS_KEEN) {
    runChain().catch(err => {
        console.error(`Fatal: ${err.message}`);
        process.exit(1);
    });
}
