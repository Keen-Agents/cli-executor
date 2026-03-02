// Two-Step Agent Chain Test
// Validates the spawn → poll → regex → chain pattern from Vic's diagram.
// Agent 1 creates a joke file, Agent 2 reads it back.
// Runs standalone (node chain-test.js) or as a Keen flow script.

const IS_KEEN = typeof dictionary !== 'undefined';

const log = IS_KEEN
    ? (msg) => writeThinking(msg)
    : (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

const output = IS_KEEN
    ? (msg) => writeOut(msg)
    : (msg) => console.log(msg);

const BRIDGE_URL = 'http://localhost:3222';
const API_TOKEN = 'b3d6d5c1a50155e207c503102f7bc610';
const POLL_INTERVAL = 3000;
const STEP_TIMEOUT = 120_000;
const COMPLETED_REGEX = /<COMPLETED>([\s\S]*?)<\/COMPLETED>/;

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

            if (stdout.trim().startsWith('{')) {
                try {
                    const parsed = JSON.parse(stdout);
                    resultText = parsed.result || stdout;
                    if (parsed.usage) {
                        log(`[${label}] Tokens: in=${parsed.usage.input_tokens || 0}, out=${parsed.usage.output_tokens || 0}`);
                    }
                    if (parsed.total_cost_usd) {
                        log(`[${label}] Cost: $${parsed.total_cost_usd.toFixed(4)}`);
                    }
                } catch {
                    log(`[${label}] Could not parse JSON, using raw stdout`);
                }
            }

            if (pollResult.exitCode !== 0) {
                log(`[${label}] Non-zero exit code. Stderr: ${(pollResult.stderr || '').substring(0, 200)}`);
                return { success: false, content: null, fullOutput: resultText, sessionId, error: pollResult.stderr };
            }

            const match = resultText.match(COMPLETED_REGEX);
            if (match) {
                const content = match[1].trim();
                log(`[${label}] <COMPLETED> found: ${content.substring(0, 100)}`);
                return { success: true, content, fullOutput: resultText, sessionId };
            }

            log(`[${label}] No <COMPLETED> tag in output`);
            log(`[${label}] Output: ${resultText.substring(0, 300)}`);
            return { success: false, content: null, fullOutput: resultText, sessionId };
        }

        if (elapsed > STEP_TIMEOUT) {
            log(`[${label}] TIMEOUT after ${Math.round(STEP_TIMEOUT / 1000)}s, killing...`);
            await bridgeCall('/api/cli/kill', { sessionId }).catch(() => {});
            return { success: false, content: null, fullOutput: pollResult.stdout || '', sessionId, timedOut: true };
        }

        log(`[${label}] Running... (${Math.round(elapsed / 1000)}s)`);
    }
}

async function runChain() {
    output('\n========================================');
    output('  Two-Step Agent Chain Test');
    output('========================================\n');

    // Create shared test directory
    const testDir = IS_KEEN ? 'D:/test-chain' : new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1').replace(/\/$/, '');
    const { mkdirSync } = await import('fs');
    const { resolve } = await import('path');
    const workDir = resolve(testDir, '..', 'test-chain');
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

    if (IS_KEEN) {
        dictionary.response = joke;
        dictionary.chainSuccess = true;
        dictionary.step1Result = step1.content;
        dictionary.step2Result = step2.content;
    }
}

export async function exec() {
    try {
        await runChain();
    } catch (error) {
        log(`Chain error: ${error.message}`);
        output(`\nFATAL: ${error.message}`);
        if (IS_KEEN) { dictionary.response = `Chain error: ${error.message}`; dictionary.chainSuccess = false; }
    }
}

if (!IS_KEEN) {
    runChain().catch(err => {
        console.error(`Fatal: ${err.message}`);
        process.exit(1);
    });
}
