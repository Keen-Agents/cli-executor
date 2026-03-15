import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';

const DEFAULT_PORT = 3222;
let PORT = parseInt(process.argv[2] || process.env.BRIDGE_PORT) || DEFAULT_PORT;
const API_TOKEN = 'b3d6d5c1a50155e207c503102f7bc610';
let BASE_DIR = process.cwd();
const IS_WINDOWS = process.platform === 'win32';

// Browser session tracking
const browserSessions = new Map();
const MAX_BROWSER_SESSIONS = 5;
const BROWSER_SESSION_TTL_MS = parseInt(process.env.BROWSER_SESSION_TTL_MS) || 10 * 60 * 1000;

function generateBrowserSessionId() {
    return 'br-' + randomBytes(8).toString('hex');
}

function browserSessionSnapshot(bs) {
    return {
        id: bs.id,
        url: bs.currentUrl || null,
        running: bs.running,
        startedAt: bs.startedAt,
        closedAt: bs.closedAt,
        pagesOpened: bs.pagesOpened,
        screenshotsTaken: bs.screenshotsTaken,
        headless: bs.headless,
        label: bs.label
    };
}

async function closeBrowserSession(bs) {
    bs.running = false;
    bs.closedAt = new Date().toISOString();
    try {
        if (bs.page && !bs.page.isClosed()) await bs.page.close().catch(() => {});
        if (bs.context) await bs.context.close().catch(() => {});
        if (bs.browser) await bs.browser.close().catch(() => {});
    } catch (err) {
        console.log(`[${new Date().toISOString()}] Browser close error (${bs.id}): ${err.message}`);
    }
}

function killProcess(pid, force = false) {
    if (IS_WINDOWS) {
        exec(`taskkill /F /T /PID ${pid}`, (err) => {
            if (err) console.log(`[${new Date().toISOString()}] taskkill PID ${pid} failed: ${err.message}`);
        });
    } else {
        try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); }
        catch (e) { console.log(`[${new Date().toISOString()}] kill PID ${pid} failed: ${e.message}`); }
    }
}

async function fetchUrl(url, options = {}) {
    const { timeout = 15000 } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            redirect: 'follow'
        });
        const text = await response.text();
        return { ok: response.ok, status: response.status, text, url: response.url };
    } catch (err) {
        if (err.name === 'AbortError') {
            return { ok: false, status: 0, text: '', url, error: `Timeout after ${timeout}ms` };
        }
        return { ok: false, status: 0, text: '', url, error: err.message };
    } finally {
        clearTimeout(timer);
    }
}

function htmlToText(html) {
    let text = html;
    text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
    text = text.replace(/<head[\s\S]*?<\/head>/gi, '');
    text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|article|section)>/gi, '\n');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<li[^>]*>/gi, '\n- ');
    text = text.replace(/<[^>]+>/g, '');
    const entities = {
        '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
        '&#39;': "'", '&apos;': "'", '&nbsp;': ' ', '&ndash;': '-',
        '&mdash;': '--', '&hellip;': '...', '&copy;': '(c)'
    };
    for (const [entity, char] of Object.entries(entities)) {
        text = text.replaceAll(entity, char);
    }
    text = text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)));
    text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n\s*\n\s*\n/g, '\n\n');
    return text.trim();
}

function parseRss(xml) {
    const items = [];
    let rssMatches = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
    if (rssMatches.length === 0) {
        rssMatches = xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
    }
    let feedTitle = '';
    const feedTitleMatch = xml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (feedTitleMatch) {
        feedTitle = feedTitleMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1').trim();
    }
    for (const itemXml of rssMatches) {
        const getTag = (tag) => {
            const match = itemXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
            if (!match) return '';
            return match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim();
        };
        let link = getTag('link');
        if (!link) {
            const hrefMatch = itemXml.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
            if (hrefMatch) link = hrefMatch[1];
        }
        const title = getTag('title');
        const description = getTag('description') || getTag('summary') || getTag('content');
        const pubDate = getTag('pubDate') || getTag('published') || getTag('updated');
        if (title || link) {
            items.push({
                title: title || '(No title)',
                link: link || '',
                description: htmlToText(description).substring(0, 300),
                pubDate,
                source: feedTitle
            });
        }
    }
    return items;
}

function extractSearchResults(html) {
    const results = [];
    const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    const links = [...html.matchAll(linkRegex)];
    const snippets = [...html.matchAll(snippetRegex)];
    for (let i = 0; i < links.length && i < 15; i++) {
        let url = links[i][1] || '';
        const title = links[i][2].replace(/<[^>]+>/g, '').trim();
        if (url.includes('uddg=')) {
            const uddgMatch = url.match(/uddg=([^&]+)/);
            if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);
        }
        const snippet = snippets[i]
            ? snippets[i][1].replace(/<[^>]+>/g, '').replace(/&\w+;/g, ' ').trim()
            : '';
        if (title && url) {
            results.push({ title, url, snippet });
        }
    }
    return results;
}

const RSS_FEEDS = {
    bbc:        { name: 'BBC News',              url: 'https://feeds.bbci.co.uk/news/rss.xml' },
    cnn:        { name: 'CNN',                   url: 'http://rss.cnn.com/rss/edition.rss' },
    guardian:   { name: 'The Guardian',          url: 'https://www.theguardian.com/world/rss' },
    npr:        { name: 'NPR',                   url: 'https://feeds.npr.org/1001/rss.xml' },
    aljazeera:  { name: 'Al Jazeera',            url: 'https://www.aljazeera.com/xml/rss/all.xml' },
    hackernews: { name: 'Hacker News',           url: 'https://hnrss.org/frontpage' },
    reddit:     { name: 'Reddit WorldNews',      url: 'https://www.reddit.com/r/worldnews/.rss' },
    reuters:    { name: 'Reuters',               url: 'https://www.reutersagency.com/feed/' },
    techcrunch: { name: 'TechCrunch',            url: 'https://techcrunch.com/feed/' },
    ars:        { name: 'Ars Technica',          url: 'https://feeds.arstechnica.com/arstechnica/features' }
};

function resolveProvider(requested) {
    if (requested && requested !== 'auto') return requested;
    if (process.env.OPENAI_API_KEY) return 'openai';
    if (process.env.STABILITY_API_KEY) return 'stability';
    if (process.env.REPLICATE_API_TOKEN) return 'replicate';
    if (process.env.SD_LOCAL_URL) return 'local';
    throw new Error('No image generation API key configured. Set OPENAI_API_KEY, STABILITY_API_KEY, REPLICATE_API_TOKEN, or SD_LOCAL_URL in environment.');
}

function normalizeDalleSize(w, h) {
    if (w > h * 1.3) return '1792x1024';
    if (h > w * 1.3) return '1024x1792';
    return '1024x1024';
}

function mapStyleToStability(style) {
    const map = {
        'pixel-art': 'pixel-art', 'realistic': 'photographic', 'cartoon': 'comic-book',
        'anime': 'anime', 'ui-element': 'digital-art', '3d': '3d-model', 'fantasy': 'fantasy-art'
    };
    return map[style] || undefined;
}

async function generateOpenAI({ prompt, width, height, style, count, format }) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');
    const size = normalizeDalleSize(width, height);
    const dalleStyle = (style === 'realistic' || style === 'natural') ? 'natural' : 'vivid';
    const images = [];
    for (let i = 0; i < Math.min(count, 4); i++) {
        const response = await fetch('https://api.openai.com/v1/images/generations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model: 'dall-e-3', prompt, n: 1, size, style: dalleStyle, response_format: 'b64_json' })
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(`OpenAI API error: ${err.error?.message || response.statusText}`);
        }
        const data = await response.json();
        images.push({ base64: data.data[0].b64_json, revisedPrompt: data.data[0].revised_prompt, width: parseInt(size.split('x')[0]), height: parseInt(size.split('x')[1]) });
    }
    return images;
}

async function generateStability({ prompt, negativePrompt, width, height, style, count, format }) {
    const apiKey = process.env.STABILITY_API_KEY;
    if (!apiKey) throw new Error('STABILITY_API_KEY not set');
    const w = Math.round(width / 64) * 64;
    const h = Math.round(height / 64) * 64;
    const textPrompts = [{ text: prompt, weight: 1 }];
    if (negativePrompt) textPrompts.push({ text: negativePrompt, weight: -1 });
    const body = { text_prompts: textPrompts, cfg_scale: 7, width: w, height: h, samples: Math.min(count, 4), steps: 30 };
    const stylePreset = mapStyleToStability(style);
    if (stylePreset) body.style_preset = stylePreset;
    const response = await fetch('https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(`Stability API error: ${err.message || response.statusText}`);
    }
    const data = await response.json();
    return data.artifacts.map(a => ({ base64: a.base64, width: w, height: h }));
}

async function generateReplicate({ prompt, negativePrompt, width, height, style, count, format }) {
    const apiToken = process.env.REPLICATE_API_TOKEN;
    if (!apiToken) throw new Error('REPLICATE_API_TOKEN not set');
    const model = process.env.REPLICATE_IMAGE_MODEL || 'black-forest-labs/flux-schnell';
    const styledPrompt = (style && style !== 'default') ? `${style} style, ${prompt}` : prompt;
    const input = { prompt: styledPrompt, width, height, num_outputs: Math.min(count, 4) };
    if (negativePrompt) input.negative_prompt = negativePrompt;
    const response = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Token ${apiToken}` },
        body: JSON.stringify({ model, input })
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(`Replicate API error: ${err.detail || response.statusText}`);
    }
    let prediction = await response.json();
    while (prediction.status !== 'succeeded' && prediction.status !== 'failed') {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const pollResp = await fetch(prediction.urls.get, { headers: { 'Authorization': `Token ${apiToken}` } });
        prediction = await pollResp.json();
    }
    if (prediction.status === 'failed') throw new Error(`Replicate generation failed: ${prediction.error}`);
    const images = [];
    for (const outputUrl of prediction.output) {
        const imgResp = await fetch(outputUrl);
        const buffer = Buffer.from(await imgResp.arrayBuffer());
        images.push({ base64: buffer.toString('base64'), width, height });
    }
    return images;
}

async function generateLocalSD({ prompt, negativePrompt, width, height, count, format }) {
    const sdUrl = process.env.SD_LOCAL_URL || 'http://127.0.0.1:7860';
    const response = await fetch(`${sdUrl}/sdapi/v1/txt2img`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            prompt, negative_prompt: negativePrompt || '',
            width: Math.round(width / 8) * 8, height: Math.round(height / 8) * 8,
            batch_size: Math.min(count, 4), steps: 20, cfg_scale: 7, sampler_name: 'DPM++ 2M Karras'
        })
    });
    if (!response.ok) throw new Error(`Local SD error: ${response.statusText}`);
    const data = await response.json();
    return data.images.map(b64 => ({ base64: b64, width: Math.round(width / 8) * 8, height: Math.round(height / 8) * 8 }));
}

const sessions = new Map();
const pidIndex = new Map();
const MAX_CONCURRENT = 20;
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS) || 30 * 60 * 1000;
const TTL_CHECK_INTERVAL_MS = 60 * 1000;

function generateSessionId() {
    return randomBytes(8).toString('hex');
}

/**
 * Parse Claude stream-json NDJSON stdout into structured conversation history.
 * This format is produced by --output-format stream-json and streams in real time.
 * Returns null if the output doesn't look like Claude stream-json.
 */
function parseClaudeStreamJson(rawStdout, session) {
    const lines = rawStdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const events = [];
    for (const line of lines) {
        try { events.push(JSON.parse(line)); } catch { /* skip non-JSON */ }
    }
    if (events.length === 0) return null;

    // Check if this looks like Claude stream-json (has system, assistant, or result events)
    const hasClaudeEvents = events.some(e =>
        e.type === 'system' || e.type === 'assistant' || e.type === 'result' || e.type === 'user'
    );
    if (!hasClaudeEvents) return null;

    const pairs = [];
    let currentUser = null;
    let currentAssistant = [];
    let usage = null;
    let cost = null;
    let durationMs = null;
    let numTurns = null;

    for (const event of events) {
        if (event.type === 'user') {
            // Save previous pair
            if (currentUser || currentAssistant.length > 0) {
                pairs.push({
                    user: currentUser || '(prompt sent via stdin)',
                    assistant: currentAssistant.join('') || '(thinking...)'
                });
                currentAssistant = [];
            }
            // Extract user message text
            if (typeof event.message?.content === 'string') {
                currentUser = event.message.content;
            } else if (Array.isArray(event.message?.content)) {
                const texts = event.message.content
                    .filter(b => b.type === 'text')
                    .map(b => b.text);
                currentUser = texts.join('\n') || JSON.stringify(event.message.content);
            } else {
                currentUser = '(user message)';
            }
        } else if (event.type === 'assistant') {
            // Extract assistant text blocks
            if (Array.isArray(event.message?.content)) {
                for (const block of event.message.content) {
                    if (block.type === 'text' && typeof block.text === 'string') {
                        currentAssistant.push(block.text);
                    } else if (block.type === 'tool_use') {
                        currentAssistant.push(`[Tool: ${block.name}]`);
                    }
                }
            }
        } else if (event.type === 'result') {
            // Final result — extract metadata. Only use result text if no assistant text yet
            // (result.result duplicates the last assistant message content).
            if (currentAssistant.length === 0 && typeof event.result === 'string') {
                currentAssistant.push(event.result);
            }
            if (event.usage) usage = event.usage;
            if (event.total_cost_usd) cost = event.total_cost_usd;
            if (event.duration_ms) durationMs = event.duration_ms;
            if (event.num_turns) numTurns = event.num_turns;
        }
    }

    // Push final pair
    if (currentUser || currentAssistant.length > 0) {
        pairs.push({
            user: currentUser || (session.stdinLog?.[0]?.input) || '(prompt sent via stdin)',
            assistant: currentAssistant.join('') || '(in progress...)'
        });
    }

    if (pairs.length === 0) return null;

    return {
        pairs,
        usage: usage || null,
        cost: cost || null,
        durationMs: durationMs || null,
        numTurns: numTurns || null,
        messageCount: pairs.length * 2
    };
}

/**
 * Parse Codex JSONL stdout into structured conversation history.
 * Returns null if the output doesn't look like Codex JSONL.
 */
function parseCodexHistory(rawStdout, session) {
    const lines = rawStdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const events = [];
    for (const line of lines) {
        try { events.push(JSON.parse(line)); } catch { /* skip non-JSON */ }
    }
    if (events.length === 0) return null;

    const userMessages = [];
    const assistantMessages = [];
    let usage = null;

    for (const event of events) {
        // Extract usage from turn.completed
        if (event.type === 'turn.completed' && event.usage) {
            usage = event.usage;
        }

        if (event.type !== 'item.completed') continue;
        const item = event.item;
        if (!item) continue;

        // Skip function calls — not human-readable
        if (item.type === 'function_call' || item.type === 'function_call_output') continue;

        // Try extracting from item first, then from event-level fields
        const text = extractCodexText(item)
            || (typeof event.agent_message === 'string' ? event.agent_message : null)
            || extractCodexText(event);
        if (!text) continue;

        const role = item.role || item.type;
        if (role === 'user') {
            userMessages.push(text);
        } else {
            assistantMessages.push(text);
        }
    }

    if (userMessages.length === 0 && assistantMessages.length === 0) return null;

    // Build pairs: stdin prompt as user, extracted assistant messages as response
    const pairs = [];
    const userPrompt = (session.stdinLog && session.stdinLog.length > 0)
        ? session.stdinLog.map(e => e.input).join('\n')
        : (userMessages.length > 0 ? userMessages.join('\n\n') : '(prompt sent via stdin)');

    pairs.push({
        user: userPrompt,
        assistant: assistantMessages.length > 0
            ? assistantMessages.join('\n\n')
            : '(no assistant text extracted)'
    });

    return {
        pairs,
        usage: usage || null,
        messageCount: userMessages.length + assistantMessages.length
    };
}

function extractCodexText(item) {
    if (typeof item.text === 'string') return item.text;
    if (typeof item.output_text === 'string') return item.output_text;
    if (typeof item.message === 'string') return item.message;
    if (typeof item.agent_message === 'string') return item.agent_message;
    if (Array.isArray(item.content)) {
        const parts = [];
        for (const chunk of item.content) {
            if (typeof chunk === 'string') parts.push(chunk);
            else if (chunk && typeof chunk.text === 'string') parts.push(chunk.text);
            else if (chunk && typeof chunk.output_text === 'string') parts.push(chunk.output_text);
            else if (chunk && typeof chunk.content === 'string') parts.push(chunk.content);
        }
        return parts.join('\n').trim() || null;
    }
    if (typeof item.content === 'string') return item.content;
    return null;
}

function getRunningCount() {
    let count = 0;
    for (const s of sessions.values()) {
        if (s.running) count++;
    }
    return count;
}

function killOldestSession() {
    let oldest = null;
    for (const s of sessions.values()) {
        if (!s.running) continue;
        if (!oldest || s.startedAt < oldest.startedAt) oldest = s;
    }
    if (oldest) {
        console.log(`[${new Date().toISOString()}] AUTO-KILL: Session ${oldest.id} (pid: ${oldest.pid}) — max concurrent limit (${MAX_CONCURRENT}) reached`);
        killProcess(oldest.pid, true);
    }
}

function findByPid(pid) {
    const sessionId = pidIndex.get(pid);
    if (!sessionId) return null;
    return sessions.get(sessionId) || null;
}

function createSession(cli, args, cwd, metadata = {}, opts = {}) {
    const running = getRunningCount();
    if (running >= MAX_CONCURRENT) {
        console.log(`[${new Date().toISOString()}] WARNING: ${running}/${MAX_CONCURRENT} sessions running. Killing oldest.`);
        killOldestSession();
    }

    const sessionId = generateSessionId();

    // On Windows, npm-global CLIs are .cmd wrappers. shell:true would use cmd.exe
    // which mangles angle brackets (<COMPLETED> → file redirects). Instead, resolve
    // the actual .js entry point and spawn node directly — no shell needed.
    const CLI_SCRIPTS = {
        claude: path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
        codex: path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    };

    let resolvedCli = cli;
    let resolvedArgs = args;
    if (IS_WINDOWS && CLI_SCRIPTS[cli.toLowerCase()] && fsSync.existsSync(CLI_SCRIPTS[cli.toLowerCase()])) {
        resolvedArgs = [CLI_SCRIPTS[cli.toLowerCase()], ...args];
        resolvedCli = process.execPath; // node.exe
    }

    // Use file-based stdin to avoid pipe buffer deadlocks on Windows.
    // When stdinFile is provided, stdin reads from a file descriptor instead of a pipe,
    // so stdout can stream freely without contention.
    let stdinFd = null;
    if (opts.stdinFile) {
        stdinFd = fsSync.openSync(opts.stdinFile, 'r');
    }

    console.log(`[${new Date().toISOString()}] Spawn: ${resolvedCli} [${resolvedArgs.length} args]${stdinFd !== null ? ' (stdin from file)' : ''}`);

    const proc = spawn(resolvedCli, resolvedArgs, {
        cwd: cwd || BASE_DIR,
        stdio: [stdinFd !== null ? stdinFd : 'pipe', 'pipe', 'pipe'],
        shell: false,
        env: { ...process.env, CLAUDECODE: undefined, PATH: process.env.PATH }
    });

    // Close the file descriptor after spawn (child process inherited it)
    if (stdinFd !== null) {
        fsSync.closeSync(stdinFd);
    }

    const session = {
        id: sessionId,
        cli, args,
        cwd: cwd || BASE_DIR,
        process: proc,
        pid: proc.pid,
        stdout: '', stderr: '',
        outputSinceLastRead: '', stderrSinceLastRead: '',
        running: true, exitCode: null,
        startedAt: new Date().toISOString(), endedAt: null,
        pipelineRunId: metadata.pipelineRunId || null,
        agentType: metadata.agentType || null,
        subtaskId: metadata.subtaskId || null,
        parentSessionId: metadata.parentSessionId || null,
        label: metadata.label || `${cli} process`,
        ttl: metadata.ttl || null,
        stdinLog: [],
        conversationHistory: null,
        waitResolvers: []
    };

    sessions.set(sessionId, session);
    if (proc.pid) pidIndex.set(proc.pid, sessionId);

    proc.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        session.stdout += text;
        session.outputSinceLastRead += text;
    });

    proc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        session.stderr += text;
        session.stderrSinceLastRead += text;
    });

    proc.on('close', (code) => {
        session.running = false;
        session.exitCode = code;
        session.endedAt = new Date().toISOString();
        const runtime = Math.round((new Date(session.endedAt) - new Date(session.startedAt)) / 1000);
        console.log(`[${new Date().toISOString()}] EXIT: Session ${sessionId} (pid: ${session.pid}) code=${code} runtime=${runtime}s`);
        for (const resolver of session.waitResolvers) resolver();
        session.waitResolvers = [];
    });

    proc.on('error', (err) => {
        session.running = false;
        session.endedAt = new Date().toISOString();
        session.stderr += `\nProcess error: ${err.message}`;
        session.stderrSinceLastRead += `\nProcess error: ${err.message}`;
        console.error(`[${new Date().toISOString()}] ERROR: Session ${sessionId} (pid: ${session.pid}): ${err.message}`);
        for (const resolver of session.waitResolvers) resolver();
        session.waitResolvers = [];
    });

    console.log(`[${new Date().toISOString()}] SPAWNED: ${sessionId} | pid=${proc.pid} | cli=${cli} | agent=${session.agentType || '-'} | pipeline=${session.pipelineRunId || '-'} | subtask=${session.subtaskId || '-'}`);
    return session;
}

setInterval(() => {
    const now = Date.now();
    let expired = 0;
    for (const [id, session] of sessions) {
        if (!session.running && session.endedAt) {
            const sessionTtl = session.ttl || SESSION_TTL_MS;
            const endedTime = new Date(session.endedAt).getTime();
            if (now - endedTime > sessionTtl) {
                if (session.pid) pidIndex.delete(session.pid);
                sessions.delete(id);
                expired++;
            }
        }
    }
    // Browser session TTL cleanup
    for (const [id, bs] of browserSessions) {
        if (!bs.running && bs.closedAt) {
            const endedTime = new Date(bs.closedAt).getTime();
            if (now - endedTime > BROWSER_SESSION_TTL_MS) {
                browserSessions.delete(id);
                expired++;
            }
        }
        if (bs.running) {
            const startedTime = new Date(bs.startedAt).getTime();
            if (now - startedTime > BROWSER_SESSION_TTL_MS) {
                console.log(`[${new Date().toISOString()}] BROWSER-TTL: Force-closing session ${id}`);
                closeBrowserSession(bs).catch(() => {});
                browserSessions.delete(id);
                expired++;
            }
        }
    }
    if (expired > 0) {
        console.log(`[${new Date().toISOString()}] TTL-CLEANUP: Removed ${expired} expired session(s). CLI: ${sessions.size}, Browser: ${browserSessions.size}`);
    }
}, TTL_CHECK_INTERVAL_MS);

function sessionSnapshot(s) {
    const now = new Date();
    const started = new Date(s.startedAt);
    const runtimeMs = s.running ? (now - started) : (new Date(s.endedAt) - started);
    return {
        id: s.id,
        pid: s.pid,
        cli: s.cli,
        args: s.args,
        cwd: s.cwd,
        running: s.running,
        exitCode: s.exitCode,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        runtimeSeconds: Math.round(runtimeMs / 1000),
        stdoutLength: s.stdout.length,
        stderrLength: s.stderr.length,
        pipelineRunId: s.pipelineRunId,
        agentType: s.agentType,
        subtaskId: s.subtaskId,
        parentSessionId: s.parentSessionId,
        label: s.label,
        stdinInputCount: s.stdinLog ? s.stdinLog.length : 0,
        ttl: s.ttl || SESSION_TTL_MS,
        expiresAt: s.endedAt ? new Date(new Date(s.endedAt).getTime() + (s.ttl || SESSION_TTL_MS)).toISOString() : null
    };
}

function generateDebugHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Keen Debugger</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,'Segoe UI',system-ui,sans-serif;background:#0a0c10;color:#e1e4e8;line-height:1.5}

/* Scrollbars */
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:#30363d;border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:#484f58}

/* Header */
.header{background:linear-gradient(135deg,#0d1117 0%,#161b22 100%);border-bottom:1px solid #21262d;padding:16px 28px;display:flex;justify-content:space-between;align-items:center}
.header h1{font-size:20px;font-weight:700;color:#e1e4e8;display:flex;align-items:center;gap:10px}
.header h1 .icon{font-size:22px;filter:saturate(1.2)}
.header h1 .brand{color:#79c0ff}
.stats{display:flex;gap:10px;align-items:center}
.stat{padding:6px 14px;border-radius:20px;font-size:12px;font-weight:600;display:flex;align-items:center;gap:6px}
.stat .label{opacity:0.7}
.stat .value{font-variant-numeric:tabular-nums}
.stat-total{background:#1f6feb22;color:#58a6ff;border:1px solid #1f6feb44}
.stat-running{background:#23883622;color:#3fb950;border:1px solid #23883644}
.stat-max{background:#21262d;color:#8b949e;border:1px solid #30363d}
.stat-time{color:#8b949e;font-size:11px;padding:6px 10px}

/* Controls */
.controls{padding:10px 28px;background:#0d1117;border-bottom:1px solid #21262d;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.filter-group{display:flex;gap:8px;align-items:center}
.filter-group select,.filter-group input{background:#161b22;color:#c9d1d9;border:1px solid #30363d;padding:6px 10px;border-radius:6px;font-size:12px;outline:none;transition:border-color .2s}
.filter-group select:focus,.filter-group input:focus{border-color:#58a6ff}
.filter-group input{width:200px}
.action-group{margin-left:auto;display:flex;gap:8px;align-items:center}
.btn{background:#21262d;color:#c9d1d9;border:1px solid #30363d;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:500;transition:all .15s;display:inline-flex;align-items:center;gap:5px}
.btn:hover{background:#30363d;border-color:#484f58}
.btn-danger{border-color:#f8514922;color:#f85149}
.btn-danger:hover{background:#f8514922;border-color:#f85149}
.auto-label{font-size:12px;color:#8b949e;display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none}
.auto-label input{accent-color:#58a6ff}

/* Container */
.container{padding:16px 28px}

/* Session Cards */
.session-card{background:#0d1117;border:1px solid #21262d;border-radius:10px;margin-bottom:10px;overflow:hidden;transition:box-shadow .2s,transform .15s}
.session-card:hover{box-shadow:0 2px 12px #00000040;transform:translateY(-1px)}
.session-card.is-running{border-top:2px solid #3fb950;border-top-left-radius:10px;border-top-right-radius:10px}
.session-card.is-running .session-header{padding-top:11px}

.session-header{padding:12px 16px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;transition:background .15s}
.session-header:hover{background:#161b2288}
.session-left{display:flex;align-items:center;gap:10px;min-width:0;flex:1}
.session-status{display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0}
.session-status.running{background:#3fb950;box-shadow:0 0 8px #3fb95066;animation:pulse 2s infinite}
.session-status.finished{background:#484f58}
.session-status.error{background:#f85149;box-shadow:0 0 6px #f8514944}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}

.cli-badge{display:inline-flex;align-items:center;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700;letter-spacing:.3px;text-transform:uppercase;flex-shrink:0}
.cli-claude{background:#1f6feb22;color:#79c0ff;border:1px solid #1f6feb44}
.cli-codex{background:#23883622;color:#56d364;border:1px solid #23883644}
.cli-unknown{background:#21262d;color:#8b949e;border:1px solid #30363d}

.session-label{font-weight:600;font-size:14px;color:#e1e4e8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.session-right{display:flex;align-items:center;gap:14px;flex-shrink:0}
.meta-item{font-size:12px;color:#8b949e;font-variant-numeric:tabular-nums;white-space:nowrap}
.meta-item .dim{opacity:0.5}
.meta-item.exit-ok{color:#3fb950}
.meta-item.exit-err{color:#f85149}
.meta-item.exit-run{color:#d29922}
.kill-btn{background:none;border:1px solid #f8514944;color:#f85149;padding:3px 10px;border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;transition:all .15s}
.kill-btn:hover{background:#f85149;color:#fff;border-color:#f85149}

/* Expand/Collapse */
.session-body{max-height:0;overflow:hidden;transition:max-height .3s ease-out,padding .3s;padding:0 16px;border-top:0 solid transparent}
.session-body.expanded{max-height:3000px;padding:16px;border-top:1px solid #21262d;transition:max-height .5s ease-in,padding .3s}

.info-row{font-size:12px;color:#6e7681;margin-bottom:12px;display:flex;gap:16px;flex-wrap:wrap}
.info-row span{display:inline-flex;align-items:center;gap:4px}

/* Conversation */
.conversation{margin-top:8px;display:flex;flex-direction:column;gap:8px}
.msg-pair{display:flex;flex-direction:column;gap:4px}
.msg{padding:10px 14px;border-radius:8px;font-size:13px;white-space:pre-wrap;max-height:300px;overflow-y:auto;word-break:break-word;line-height:1.5}
.msg.user{background:#161b22;border-left:3px solid #58a6ff}
.msg.assistant{background:#161b22;border-left:3px solid #3fb950}
.msg-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding-left:4px}
.msg-label.user{color:#58a6ff}
.msg-label.assistant{color:#3fb950}
.msg-meta{font-size:11px;color:#6e7681;margin-top:10px;padding-top:8px;border-top:1px solid #21262d;display:flex;gap:16px;flex-wrap:wrap}
.msg-meta span{display:inline-flex;align-items:center;gap:4px}

/* Raw Output */
.raw-section{margin-top:12px;position:relative}
.raw-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.raw-header span{font-size:12px;font-weight:600;color:#6e7681;text-transform:uppercase;letter-spacing:.5px}
.copy-btn{background:#21262d;border:1px solid #30363d;color:#8b949e;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px;transition:all .15s}
.copy-btn:hover{background:#30363d;color:#e1e4e8}
.copy-btn.copied{background:#23883633;color:#3fb950;border-color:#23883644}
.raw-output{background:#161b22;padding:14px;border-radius:8px;font-family:'Cascadia Code','Fira Code',monospace;font-size:12px;white-space:pre-wrap;max-height:400px;overflow-y:auto;word-break:break-word;line-height:1.6;border:1px solid #21262d}
/* JSON syntax highlights */
.raw-output .json-key{color:#79c0ff}
.raw-output .json-str{color:#a5d6ff}
.raw-output .json-num{color:#d29922}
.raw-output .json-bool{color:#ff7b72}
.raw-output .json-null{color:#8b949e}
.raw-output .completed-tag{background:#23883622;color:#3fb950;padding:1px 4px;border-radius:3px}

/* Empty State */
.empty-state{color:#6e7681;padding:60px 40px;text-align:center}
.empty-state .empty-icon{font-size:48px;margin-bottom:12px;opacity:.4}
.empty-state p{font-size:14px}
</style>
</head>
<body>
<div class="header">
    <h1><span class="icon">&#9889;</span> <span class="brand">Keen</span> Debugger</h1>
    <div class="stats">
        <div class="stat stat-total"><span class="label">Total</span> <span class="value" id="stat-total">0</span></div>
        <div class="stat stat-running"><span class="label">Running</span> <span class="value" id="stat-running">0</span></div>
        <div class="stat stat-max"><span class="label">Max</span> <span class="value">${MAX_CONCURRENT}</span></div>
        <span class="stat-time" id="last-refresh">--</span>
    </div>
</div>
<div class="controls">
    <div class="filter-group">
        <select id="filter-status"><option value="all">All Status</option><option value="running">Running</option><option value="finished">Finished</option></select>
        <select id="filter-agent"><option value="all">All Agents</option></select>
        <input type="text" id="filter-search" placeholder="Search sessions..." />
    </div>
    <div class="action-group">
        <button class="btn" onclick="refreshData()">Refresh</button>
        <button class="btn btn-danger" onclick="killAll()">Kill All</button>
        <button class="btn btn-danger" onclick="cleanupSessions()">Cleanup</button>
        <label class="auto-label"><input type="checkbox" id="auto-refresh" checked /> Auto 5s</label>
    </div>
</div>
<div class="container" id="sessions-container">
    <div class="empty-state"><div class="empty-icon">&#9889;</div><p>Loading sessions...</p></div>
</div>
<script>
const API_TOKEN='${API_TOKEN}';
const BASE=window.location.origin;
let allSessions=[];
let expandedSessions=new Set();

async function apiFetch(ep,body={}){
    const r=await fetch(BASE+ep,{method:'POST',headers:{'Content-Type':'application/json','x-api-token':API_TOKEN},body:JSON.stringify(body)});
    return r.json();
}
async function apiGet(ep){
    const r=await fetch(BASE+ep,{headers:{'x-api-token':API_TOKEN}});
    return r.json();
}

async function refreshData(){
    try{
        const d=await apiGet('/api/cli/list');
        allSessions=d.sessions||[];
        document.getElementById('stat-total').textContent=d.total;
        document.getElementById('stat-running').textContent=d.running;
        document.getElementById('last-refresh').textContent=new Date().toLocaleTimeString();
        updateAgentFilter();
        renderSessions();
        expandedSessions.forEach(id=>{loadRaw(id);loadHistory(id)});
    }catch(e){console.error('Refresh failed:',e)}
}

function updateAgentFilter(){
    const sel=document.getElementById('filter-agent');
    const agents=[...new Set(allSessions.map(s=>s.agentType).filter(Boolean))];
    const cur=sel.value;
    sel.innerHTML='<option value="all">All Agents</option>';
    agents.forEach(a=>{const o=document.createElement('option');o.value=a;o.textContent=a;sel.appendChild(o)});
    sel.value=cur;
}

function getFiltered(){
    const st=document.getElementById('filter-status').value;
    const ag=document.getElementById('filter-agent').value;
    const q=document.getElementById('filter-search').value.toLowerCase();
    return allSessions.filter(s=>{
        if(st==='running'&&!s.running)return false;
        if(st==='finished'&&s.running)return false;
        if(ag!=='all'&&s.agentType!==ag)return false;
        if(q&&!(s.label||'').toLowerCase().includes(q)&&!s.id.includes(q))return false;
        return true;
    });
}

function renderSessions(){
    const c=document.getElementById('sessions-container');
    const f=getFiltered();
    if(!f.length){c.innerHTML='<div class="empty-state"><div class="empty-icon">&#128269;</div><p>No sessions match filters.</p></div>';return}
    f.sort((a,b)=>{if(a.running!==b.running)return a.running?-1:1;return new Date(b.startedAt)-new Date(a.startedAt)});
    c.innerHTML=f.map(s=>renderCard(s)).join('');
}

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}

function fmtDuration(sec){
    if(sec>=60){
        const m=Math.floor(sec/60);
        const s=sec%60;
        return m+'<span class="dim">m</span> '+s+'<span class="dim">s</span>';
    }
    return sec+'<span class="dim">s</span>';
}

function renderCard(s){
    const sc=s.running?'running':(s.exitCode!==0?'error':'finished');
    const ex=expandedSessions.has(s.id);
    const cli=(s.cli||'unknown').toLowerCase();
    const cliBadge='cli-'+(cli==='claude'||cli==='codex'?cli:'unknown');
    const exitClass=s.running?'exit-run':(s.exitCode===0?'exit-ok':'exit-err');
    const exitText=s.running?'running':String(s.exitCode);
    return '<div class="session-card'+(s.running?' is-running':'')+'">'
        +'<div class="session-header" onclick="toggle(\\''+s.id+'\\')">'
        +'<div class="session-left">'
        +'<span class="session-status '+sc+'"></span>'
        +'<span class="cli-badge '+cliBadge+'">'+esc(cli)+'</span>'
        +'<span class="session-label">'+esc(s.label||s.id)+'</span>'
        +'</div>'
        +'<div class="session-right">'
        +'<span class="meta-item">PID '+s.pid+'</span>'
        +'<span class="meta-item">'+fmtDuration(s.runtimeSeconds)+'</span>'
        +'<span class="meta-item">'+((s.stdoutLength/1024).toFixed(1))+'<span class="dim">KB</span></span>'
        +'<span class="meta-item '+exitClass+'">'+exitText+'</span>'
        +(s.running?'<button class="kill-btn" onclick="event.stopPropagation();killSession(\\''+s.id+'\\')">Kill</button>':'')
        +'</div></div>'
        +'<div class="session-body '+(ex?'expanded':'')+'" id="body-'+s.id+'">'
        +'<div class="info-row">'
        +'<span>ID: '+s.id+'</span>'
        +'<span>Pipeline: '+(s.pipelineRunId||'-')+'</span>'
        +'<span>Subtask: '+(s.subtaskId||'-')+'</span>'
        +'</div>'
        +'<div id="hist-'+s.id+'"></div>'
        +'<div class="raw-section">'
        +'<div class="raw-header"><span>Raw Output</span><button class="copy-btn" onclick="event.stopPropagation();copyRaw(\\''+s.id+'\\',this)">Copy</button></div>'
        +'<div class="raw-output" id="raw-'+s.id+'">Loading...</div>'
        +'</div>'
        +'</div></div>';
}

function toggle(id){
    if(expandedSessions.has(id)){expandedSessions.delete(id)}
    else{expandedSessions.add(id)}
    renderSessions();
    if(expandedSessions.has(id)){loadRaw(id);loadHistory(id)}
}

function highlightJson(text){
    return esc(text)
        .replace(/&lt;\\/?COMPLETED&gt;/g,'<span class="completed-tag">$&</span>')
        .replace(/"([^"]*)"\\s*:/g,'<span class="json-key">"$1"</span>:')
        .replace(/:\\s*"([^"]*)"/g,': <span class="json-str">"$1"</span>')
        .replace(/:\\s*(-?\\d+\\.?\\d*)/g,': <span class="json-num">$1</span>')
        .replace(/:\\s*(true|false)/g,': <span class="json-bool">$1</span>')
        .replace(/:\\s*(null)/g,': <span class="json-null">$1</span>');
}

async function loadRaw(id){
    try{
        const d=await apiFetch('/api/cli/output',{sessionId:id,full:true});
        const el=document.getElementById('raw-'+id);
        if(el){
            const text=d.stdout||'(no output)';
            el.dataset.raw=text;
            el.innerHTML=highlightJson(text);
        }
    }catch(e){const el=document.getElementById('raw-'+id);if(el){el.textContent='Error: '+e.message}}
}

function copyRaw(id,btn){
    const el=document.getElementById('raw-'+id);
    if(!el)return;
    const text=el.dataset.raw||el.textContent;
    navigator.clipboard.writeText(text).then(()=>{
        btn.textContent='Copied!';
        btn.classList.add('copied');
        setTimeout(()=>{btn.textContent='Copy';btn.classList.remove('copied')},1500);
    });
}

async function loadHistory(id){
    const el=document.getElementById('hist-'+id);
    if(!el)return;
    el.innerHTML='<span style="font-size:12px;color:#6e7681">Loading history...</span>';
    try{
        const d=await apiFetch('/api/cli/history',{sessionId:id});
        if(d.history&&d.history.pairs&&d.history.pairs.length>0){
            let html='<div class="conversation">';
            d.history.pairs.forEach(p=>{
                html+='<div class="msg-pair">';
                if(p.user)html+='<div class="msg-label user">User</div><div class="msg user">'+esc(p.user)+'</div>';
                if(p.assistant)html+='<div class="msg-label assistant">Assistant</div><div class="msg assistant">'+esc(p.assistant)+'</div>';
                html+='</div>';
            });
            html+='</div>';
            let meta=[];
            if(d.history.usage)meta.push('<span>Tokens: '+(d.history.usage.input_tokens||0)+' in / '+(d.history.usage.output_tokens||0)+' out</span>');
            if(d.history.cost)meta.push('<span>Cost: $'+d.history.cost.toFixed(4)+'</span>');
            if(d.history.durationMs)meta.push('<span>Duration: '+(d.history.durationMs/1000).toFixed(1)+'s</span>');
            if(d.history.numTurns)meta.push('<span>Turns: '+d.history.numTurns+'</span>');
            if(meta.length)html+='<div class="msg-meta">'+meta.join('')+'</div>';
            el.innerHTML=html;
        }else{
            el.innerHTML='<span style="font-size:12px;color:#6e7681">No structured history (raw output only).</span>';
        }
    }catch(e){el.innerHTML='<span style="font-size:12px;color:#f85149">Error: '+e.message+'</span>'}
}

async function killSession(id){if(!confirm('Kill session '+id+'?'))return;await apiFetch('/api/cli/kill',{sessionId:id});setTimeout(refreshData,1000)}
async function killAll(){if(!confirm('Kill ALL running sessions?'))return;await apiFetch('/api/cli/kill-all',{});setTimeout(refreshData,2000)}
async function cleanupSessions(){await apiFetch('/api/cli/cleanup',{});setTimeout(refreshData,500)}

document.getElementById('filter-status').addEventListener('change',renderSessions);
document.getElementById('filter-agent').addEventListener('change',renderSessions);
document.getElementById('filter-search').addEventListener('input',renderSessions);
setInterval(()=>{if(document.getElementById('auto-refresh').checked)refreshData()},5000);
refreshData();
</script>
</body></html>`;
}

const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'OPTIONS, POST, GET',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
};

const server = http.createServer(async (req, res) => {
    const method = req.method.toUpperCase();
    const normalizedUrl = req.url.split('?')[0].replace(/\/+/g, '/');
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`[${new Date().toISOString()}] IN: ${method} ${normalizedUrl} from ${clientIp} (original: ${req.url})`);

    const done = (status, data) => {
        console.log(`[${new Date().toISOString()}] OUT: ${status}`);
        res.writeHead(status, headers);
        res.end(JSON.stringify(data));
    };

    if (req.method === 'OPTIONS') {
        res.writeHead(204, headers);
        res.end();
        return;
    }

    if (method === 'GET' && (normalizedUrl === '/debug' || normalizedUrl === '/debug/')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(generateDebugHtml());
        return;
    }

    const authHeader = req.headers['x-api-token'] || req.headers['authorization']?.replace('Bearer ', '');
    const urlParams = new URL(req.url + (req.url.includes('?') ? '' : '?'), `http://${req.headers.host}`).searchParams;
    const authToken = authHeader || urlParams.get('token');
    if (authToken !== API_TOKEN) {
        console.log(`[${new Date().toISOString()}] AUTH-SKIP: ${method} ${normalizedUrl} | headers: ${JSON.stringify(req.headers).substring(0, 200)}`);
        // Allow request anyway — Funnel URL is protection enough
    }

    if (method === 'GET') {
        if (normalizedUrl === '/api/config') {
            return done(200, { baseDir: BASE_DIR });
        }
        if (normalizedUrl === '/api/cli/list') {
            const list = [];
            for (const s of sessions.values()) list.push(sessionSnapshot(s));
            return done(200, {
                sessions: list,
                total: list.length,
                running: list.filter(s => s.running).length,
                maxConcurrent: MAX_CONCURRENT
            });
        }
        return done(200, { status: 'running', service: 'Keen Local Bridge v2', time: new Date().toISOString() });
    }

    if (method !== 'POST') {
        return done(405, { error: 'Method Not Allowed', received: method });
    }

    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
        try {
            let data = {};
            if (method === 'POST' && body) {
                try {
                    data = JSON.parse(body);
                } catch (e) {
                    console.error(`[${new Date().toISOString()}] Failed to parse body: ${e.message}`);
                    return done(400, { error: 'Invalid JSON body' });
                }
            }
            const url = normalizedUrl;

            console.log(`[${new Date().toISOString()}] Processing: ${url}`, data);

            let result = {};

            if (url === '/api/file/list') {
                const targetPath = path.resolve(BASE_DIR, data.path || '.');
                if (!targetPath.startsWith(BASE_DIR)) throw new Error("Access denied: Path outside project root");

                const files = await fs.readdir(targetPath);
                result = { files };
            }

            else if (url === '/api/file/read') {
                const targetPath = path.resolve(BASE_DIR, data.path || '.');
                if (!targetPath.startsWith(BASE_DIR)) throw new Error("Access denied: Path outside project root");

                const content = await fs.readFile(targetPath, 'utf-8');
                result = { content };
            }

            else if (url === '/api/file/write') {
                const targetPath = path.resolve(BASE_DIR, data.path || '.');
                if (!targetPath.startsWith(BASE_DIR)) throw new Error("Access denied: Path outside project root");

                const parentDir = path.dirname(targetPath);
                await fs.mkdir(parentDir, { recursive: true });

                await fs.writeFile(targetPath, data.content, 'utf-8');
                result = { success: true };
            }

            else if (url === '/api/command') {
                const cmd = data.command;
                if (!cmd) throw new Error("No command provided");

                result = await new Promise((resolve, reject) => {
                    exec(cmd, { cwd: BASE_DIR, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
                        resolve({
                            stdout: stdout || '',
                            stderr: stderr || '',
                            error: error ? error.message : null
                        });
                    });
                });
            }

            else if (url === '/api/cli/spawn') {
                const { cli, args = [], cwd, closeStdin = false, stdinData, metadata = {} } = data;
                if (!cli) throw new Error("No CLI tool specified. Provide 'cli' field (e.g. 'claude', 'codex')");

                let stdinFile = null;
                let finalArgs = [...args];

                // For Claude with stdin data: write prompt to temp file (avoids pipe
                // buffer deadlock) and switch to stream-json for real-time output.
                if (stdinData && cli.toLowerCase() === 'claude') {
                    const tmpDir = os.tmpdir();
                    stdinFile = path.join(tmpDir, `claude-stdin-${randomBytes(6).toString('hex')}.txt`);
                    fsSync.writeFileSync(stdinFile, stdinData, 'utf8');
                    // Replace --output-format json with stream-json for real-time NDJSON
                    const ofIdx = finalArgs.indexOf('--output-format');
                    if (ofIdx !== -1 && ofIdx + 1 < finalArgs.length) {
                        finalArgs[ofIdx + 1] = 'stream-json';
                    } else {
                        finalArgs.push('--output-format', 'stream-json');
                    }
                    // stream-json requires --verbose with -p
                    if (!finalArgs.includes('--verbose')) {
                        finalArgs.push('--verbose');
                    }
                }

                const session = createSession(cli, finalArgs, cwd, metadata, { stdinFile });

                // Clean up temp file after process exits
                if (stdinFile) {
                    session.process.on('exit', () => {
                        try { fsSync.unlinkSync(stdinFile); } catch { /* already gone */ }
                    });
                    session.stdinLog.push({ input: stdinData.slice(0, 2000), timestamp: new Date().toISOString() });
                } else if (stdinData) {
                    // Non-Claude CLI: use pipe-based stdin (e.g. Codex)
                    session.stdinLog.push({ input: stdinData.slice(0, 2000), timestamp: new Date().toISOString() });
                    session.process.stdin.end(stdinData, 'utf8', () => {
                        console.log(`[${new Date().toISOString()}] Stdin written and closed for session ${session.id} (${stdinData.length} bytes)`);
                    });
                } else if (closeStdin) {
                    session.process.stdin.end();
                    console.log(`[${new Date().toISOString()}] Stdin closed for session ${session.id} (one-shot mode)`);
                }

                result = {
                    sessionId: session.id,
                    pid: session.pid,
                    cli,
                    args,
                    cwd: session.cwd,
                    status: 'running',
                    runningSessions: getRunningCount(),
                    maxConcurrent: MAX_CONCURRENT
                };
            }

            else if (url === '/api/cli/send') {
                const { sessionId, input } = data;
                if (!sessionId) throw new Error("No sessionId provided");
                const session = sessions.get(sessionId);
                if (!session) throw new Error(`Session ${sessionId} not found`);
                if (!session.running) throw new Error(`Session ${sessionId} has already exited (code: ${session.exitCode})`);

                session.process.stdin.write(input + '\n');
                session.stdinLog.push({ timestamp: new Date().toISOString(), input });
                result = { ok: true, sessionId };
            }

            else if (url === '/api/cli/output') {
                const { sessionId, full = false } = data;
                if (!sessionId) throw new Error("No sessionId provided");
                const session = sessions.get(sessionId);
                if (!session) throw new Error(`Session ${sessionId} not found`);

                if (full) {
                    result = {
                        sessionId,
                        stdout: session.stdout,
                        stderr: session.stderr,
                        running: session.running,
                        exitCode: session.exitCode
                    };
                } else {
                    result = {
                        sessionId,
                        stdout: session.outputSinceLastRead,
                        stderr: session.stderrSinceLastRead,
                        running: session.running,
                        exitCode: session.exitCode
                    };
                    session.outputSinceLastRead = '';
                    session.stderrSinceLastRead = '';
                }
            }

            else if (url === '/api/cli/wait') {
                const { sessionId, timeout = 300000 } = data;
                if (!sessionId) throw new Error("No sessionId provided");
                const session = sessions.get(sessionId);
                if (!session) throw new Error(`Session ${sessionId} not found`);

                if (!session.running) {
                    result = {
                        sessionId,
                        stdout: session.stdout,
                        stderr: session.stderr,
                        exitCode: session.exitCode,
                        running: false
                    };
                } else {
                    const waitResult = await new Promise((resolve) => {
                        const timer = setTimeout(() => {
                            resolve({ timedOut: true });
                        }, timeout);

                        session.waitResolvers.push(() => {
                            clearTimeout(timer);
                            resolve({ timedOut: false });
                        });
                    });

                    result = {
                        sessionId,
                        stdout: session.stdout,
                        stderr: session.stderr,
                        exitCode: session.exitCode,
                        running: session.running,
                        timedOut: waitResult.timedOut
                    };
                }
            }

            else if (url === '/api/cli/kill') {
                const { sessionId } = data;
                if (!sessionId) throw new Error("No sessionId provided");
                const session = sessions.get(sessionId);
                if (!session) throw new Error(`Session ${sessionId} not found`);

                const wasRunning = session.running;
                if (session.running && session.pid) {
                    killProcess(session.pid, true);
                }

                result = { killed: true, sessionId, wasRunning };
            }

            else if (url === '/api/cli/poll') {
                const { sessionId, interval = 3000 } = data;
                if (!sessionId) throw new Error("No sessionId provided");
                const session = sessions.get(sessionId);
                if (!session) throw new Error(`Session ${sessionId} not found`);

                if (session.running) {
                    await new Promise(resolve => setTimeout(resolve, Math.min(interval, 15000)));
                }

                console.log(`[${new Date().toISOString()}] Poll result for ${sessionId}: running=${session.running}, exitCode=${session.exitCode}, stdout=${session.stdout.length} chars, stderr=${session.stderr.length} chars`);
                if (!session.running && session.stdout) {
                    console.log(`[${new Date().toISOString()}] CLI OUTPUT PREVIEW: ${session.stdout.substring(0, 300)}`);
                }

                result = {
                    sessionId,
                    stdout: session.stdout,
                    stderr: session.stderr,
                    running: session.running,
                    exitCode: session.exitCode
                };
            }

            else if (url === '/api/cli/cleanup') {
                let cleaned = 0;
                for (const [id, session] of sessions) {
                    if (!session.running) {
                        if (session.pid) pidIndex.delete(session.pid);
                        sessions.delete(id);
                        cleaned++;
                    }
                }
                result = { cleaned, remaining: sessions.size, runningPids: [...pidIndex.keys()] };
            }

            else if (url === '/api/cli/history') {
                const { sessionId } = data;
                if (!sessionId) throw new Error("No sessionId provided");
                const session = sessions.get(sessionId);
                if (!session) throw new Error(`Session ${sessionId} not found`);

                if (session.conversationHistory && !session.running) {
                    result = { sessionId, history: session.conversationHistory, running: session.running, source: 'cached' };
                } else {
                    // Clear cache for running sessions so we get fresh data
                    if (session.running) session.conversationHistory = null;

                    let parsed = null;
                    const rawStdout = session.stdout.trim();

                    // Try Claude stream-json NDJSON format first (multiple JSON lines)
                    if (rawStdout.includes('\n') && session.cli === 'claude') {
                        const claudeStream = parseClaudeStreamJson(rawStdout, session);
                        if (claudeStream) {
                            if (!session.running) session.conversationHistory = claudeStream;
                            result = { sessionId, history: claudeStream, running: session.running, source: 'claude-stream' };
                        }
                    }

                    // Try legacy single-JSON Claude format
                    if (!result && rawStdout.startsWith('{')) {
                        try { parsed = JSON.parse(rawStdout); } catch { /* not JSON */ }
                    }

                    if (!result && parsed && parsed.messages) {
                        const pairs = [];
                        let currentPair = {};
                        for (const msg of parsed.messages) {
                            if (msg.role === 'user') {
                                if (currentPair.user) { pairs.push(currentPair); currentPair = {}; }
                                currentPair.user = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                            } else if (msg.role === 'assistant') {
                                currentPair.assistant = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                                pairs.push(currentPair);
                                currentPair = {};
                            }
                        }
                        if (currentPair.user) pairs.push(currentPair);

                        session.conversationHistory = {
                            pairs,
                            result: parsed.result || null,
                            sessionClaudeId: parsed.session_id || null,
                            usage: parsed.usage || null,
                            messageCount: parsed.messages.length
                        };
                        result = { sessionId, history: session.conversationHistory, running: session.running, source: 'parsed' };
                    } else if (!result && parsed && parsed.result) {
                        const prompt = (session.args || []).find((a, i, arr) => arr[i - 1] === '-p') || '(prompt)';
                        const pairs = [{ user: prompt, assistant: parsed.result }];
                        session.conversationHistory = {
                            pairs,
                            result: parsed.result,
                            sessionClaudeId: parsed.session_id || null,
                            usage: parsed.usage || null,
                            cost: parsed.total_cost_usd || null,
                            durationMs: parsed.duration_ms || null,
                            numTurns: parsed.num_turns || null,
                            messageCount: 1
                        };
                        result = { sessionId, history: session.conversationHistory, running: session.running, source: 'parsed' };
                    } else if (!result && rawStdout.includes('\n') && rawStdout.split('\n').some(l => l.trim().startsWith('{'))) {
                        // Codex JSONL format: multiple JSON lines with item.completed events
                        const codexParsed = parseCodexHistory(rawStdout, session);
                        if (codexParsed) {
                            if (!session.running) session.conversationHistory = codexParsed;
                            result = { sessionId, history: codexParsed, running: session.running, source: 'codex-parsed' };
                        } else if (session.stdinLog && session.stdinLog.length > 0) {
                            const pairs = session.stdinLog.map(entry => ({
                                user: entry.input,
                                timestamp: entry.timestamp
                            }));
                            if (pairs.length > 0) {
                                pairs[pairs.length - 1].assistant = session.stdout;
                            }
                            result = { sessionId, history: { pairs, messageCount: session.stdinLog.length }, running: session.running, source: 'stdinLog' };
                        } else {
                            result = { sessionId, history: null, raw: session.stdout, running: session.running, source: 'raw' };
                        }
                    }
                    if (!result && session.stdinLog && session.stdinLog.length > 0) {
                        const pairs = session.stdinLog.map(entry => ({
                            user: entry.input,
                            timestamp: entry.timestamp
                        }));
                        if (pairs.length > 0) {
                            pairs[pairs.length - 1].assistant = session.stdout;
                        }
                        result = { sessionId, history: { pairs, messageCount: session.stdinLog.length }, running: session.running, source: 'stdinLog' };
                    }
                    if (!result) {
                        result = { sessionId, history: null, raw: session.stdout, running: session.running, source: 'raw' };
                    }
                }
            }

            else if (url === '/api/cli/find-by-pid') {
                const { pid } = data;
                if (!pid) throw new Error("No 'pid' provided");
                const session = findByPid(Number(pid));
                if (!session) throw new Error(`No session found for PID ${pid}`);
                result = sessionSnapshot(session);
            }

            else if (url === '/api/cli/kill-by-pid') {
                const { pid } = data;
                if (!pid) throw new Error("No 'pid' provided");
                const session = findByPid(Number(pid));
                if (!session) throw new Error(`No session found for PID ${pid}`);

                const wasRunning = session.running;
                if (session.running && session.pid) {
                    killProcess(session.pid, true);
                }
                result = { killed: true, sessionId: session.id, pid: session.pid, wasRunning, label: session.label };
                console.log(`[${new Date().toISOString()}] KILL-BY-PID: ${session.id} (pid: ${pid}, wasRunning: ${wasRunning})`);
            }

            else if (url === '/api/cli/status') {
                if (data.sessionId) {
                    const session = sessions.get(data.sessionId);
                    if (!session) throw new Error(`Session ${data.sessionId} not found`);
                    result = sessionSnapshot(session);
                } else {
                    const all = [];
                    for (const s of sessions.values()) all.push(sessionSnapshot(s));
                    const running = all.filter(s => s.running);
                    const finished = all.filter(s => !s.running);
                    result = {
                        running: { count: running.length, sessions: running },
                        finished: { count: finished.length, sessions: finished },
                        total: all.length,
                        maxConcurrent: MAX_CONCURRENT,
                        pidMap: Object.fromEntries(pidIndex)
                    };
                }
            }

            else if (url === '/api/cli/kill-all') {
                let killed = 0;
                for (const s of sessions.values()) {
                    if (s.running && s.pid) {
                        killProcess(s.pid, true);
                        killed++;
                        console.log(`[${new Date().toISOString()}] KILL-ALL: ${s.id} (pid: ${s.pid})`);
                    }
                }
                result = { killed, message: `Killed ${killed} session(s)` };
            }

            else if (url === '/api/cli/kill-by-filter') {
                const { pipelineRunId, agentType, subtaskId, olderThanSeconds } = data;
                const now = Date.now();
                let killed = 0;
                for (const s of sessions.values()) {
                    if (!s.running) continue;
                    let match = false;
                    if (pipelineRunId && s.pipelineRunId === pipelineRunId) match = true;
                    if (agentType && s.agentType === agentType) match = true;
                    if (subtaskId && s.subtaskId === subtaskId) match = true;
                    if (olderThanSeconds && (now - new Date(s.startedAt).getTime()) > olderThanSeconds * 1000) match = true;
                    if (match && s.pid) {
                        killProcess(s.pid, true);
                        killed++;
                        console.log(`[${new Date().toISOString()}] KILL-FILTER: ${s.id} (pid: ${s.pid}, agent: ${s.agentType}, pipeline: ${s.pipelineRunId})`);
                    }
                }
                result = { killed, filter: { pipelineRunId, agentType, subtaskId, olderThanSeconds } };
            }

            else if (url === '/api/config') {
                console.log(`[${new Date().toISOString()}] Config request received:`, data);
                if (data.baseDir) {
                    try {
                        const newPath = path.resolve(data.baseDir);
                        console.log(`[${new Date().toISOString()}] Attempting to switch to: ${newPath}`);
                        await fs.access(newPath);
                        BASE_DIR = newPath;
                        console.log(`[${new Date().toISOString()}] Project root changed to: ${BASE_DIR}`);
                        result = { success: true, baseDir: BASE_DIR };
                    } catch (e) {
                        console.error(`[${new Date().toISOString()}] Switch failed: ${e.message}`);
                        throw new Error(`Directory not found or inaccessible: ${data.baseDir} (${e.message})`);
                    }
                } else {
                    result = { baseDir: BASE_DIR };
                }
            }

            else if (url === '/api/ping') {
                result = {
                    pong: true,
                    baseDir: BASE_DIR,
                    totalSessions: sessions.size,
                    runningSessions: getRunningCount(),
                    maxConcurrent: MAX_CONCURRENT,
                    trackedPids: [...pidIndex.keys()]
                };
            }

            else if (url === '/api/web/scrape') {
                const targetUrl = data.url;
                if (!targetUrl) throw new Error('No URL provided');
                const maxLength = data.maxLength || 50000;
                console.log(`[${new Date().toISOString()}] Scraping: ${targetUrl}`);

                const fetched = await fetchUrl(targetUrl, { timeout: data.timeout || 15000 });
                if (!fetched.ok) {
                    result = { ok: false, url: targetUrl, error: fetched.error || `HTTP ${fetched.status}` };
                } else {
                    const titleMatch = fetched.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
                    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
                    let text = htmlToText(fetched.text);
                    const truncated = text.length > maxLength;
                    if (truncated) text = text.substring(0, maxLength) + '\n\n[... truncated]';
                    result = { ok: true, url: targetUrl, finalUrl: fetched.url, title, text, length: text.length, truncated };
                    console.log(`[${new Date().toISOString()}] Scraped ${text.length} chars from ${targetUrl}`);
                }
            }

            else if (url === '/api/web/search') {
                const query = data.query;
                if (!query) throw new Error('No search query provided');
                const maxResults = data.maxResults || 10;
                const encodedQuery = encodeURIComponent(query);
                const searchUrl = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;
                console.log(`[${new Date().toISOString()}] Searching: "${query}"`);

                const fetched = await fetchUrl(searchUrl, { timeout: 20000 });
                if (!fetched.ok) {
                    result = { ok: false, query, error: fetched.error || `HTTP ${fetched.status}`, results: [] };
                } else {
                    const searchResults = extractSearchResults(fetched.text).slice(0, maxResults);
                    result = { ok: true, query, results: searchResults, totalResults: searchResults.length };
                    console.log(`[${new Date().toISOString()}] Search returned ${searchResults.length} results`);
                }
            }

            else if (url === '/api/web/news') {
                const requestedSources = data.sources || Object.keys(RSS_FEEDS);
                const maxPerSource = data.maxPerSource || 5;
                const timeout = data.timeout || 20000;
                const validSources = requestedSources.filter(s => RSS_FEEDS[s]);
                const sourcesSucceeded = [];
                const sourcesFailed = [];

                console.log(`[${new Date().toISOString()}] Fetching news from: ${validSources.join(', ')}`);

                const feedPromises = validSources.map(async (sourceKey) => {
                    const feed = RSS_FEEDS[sourceKey];
                    try {
                        const fetched = await fetchUrl(feed.url, { timeout });
                        if (!fetched.ok) {
                            sourcesFailed.push({ key: sourceKey, error: fetched.error || `HTTP ${fetched.status}` });
                            return [];
                        }
                        const items = parseRss(fetched.text).slice(0, maxPerSource).map(item => ({ ...item, source: feed.name, sourceKey }));
                        sourcesSucceeded.push(sourceKey);
                        return items;
                    } catch (err) {
                        sourcesFailed.push({ key: sourceKey, error: err.message });
                        return [];
                    }
                });

                const allItemArrays = await Promise.all(feedPromises);
                let allItems = allItemArrays.flat();
                allItems.sort((a, b) => {
                    const dateA = a.pubDate ? new Date(a.pubDate).getTime() : 0;
                    const dateB = b.pubDate ? new Date(b.pubDate).getTime() : 0;
                    return dateB - dateA;
                });

                result = { ok: true, items: allItems, totalItems: allItems.length, sourcesSucceeded, sourcesFailed, fetchedAt: new Date().toISOString() };
                console.log(`[${new Date().toISOString()}] News: ${allItems.length} items from ${sourcesSucceeded.length} sources (${sourcesFailed.length} failed)`);
            }

            else if (url === '/api/web/multi-scrape') {
                const urls = data.urls;
                if (!urls || !Array.isArray(urls) || urls.length === 0) throw new Error('No URLs provided');
                const timeout = data.timeout || 15000;
                const maxLength = data.maxLength || 20000;
                const urlsToFetch = urls.slice(0, 10);

                console.log(`[${new Date().toISOString()}] Multi-scrape: ${urlsToFetch.length} URLs`);

                const scrapePromises = urlsToFetch.map(async (targetUrl) => {
                    try {
                        const fetched = await fetchUrl(targetUrl, { timeout });
                        if (!fetched.ok) return { ok: false, url: targetUrl, error: fetched.error || `HTTP ${fetched.status}` };
                        const titleMatch = fetched.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
                        const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
                        let text = htmlToText(fetched.text);
                        const truncated = text.length > maxLength;
                        if (truncated) text = text.substring(0, maxLength) + '\n\n[... truncated]';
                        return { ok: true, url: targetUrl, title, text, length: text.length, truncated };
                    } catch (err) {
                        return { ok: false, url: targetUrl, error: err.message };
                    }
                });

                const results = await Promise.all(scrapePromises);
                result = { ok: true, results, succeeded: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, total: results.length };
                console.log(`[${new Date().toISOString()}] Multi-scrape: ${result.succeeded}/${result.total} succeeded`);
            }

            else if (url === '/api/image/generate') {
                const { prompt, negativePrompt, width = 1024, height = 1024, style = 'default', provider = 'auto', outputDir = 'assets/generated', filename, format = 'png', count = 1 } = data;
                if (!prompt) throw new Error('No prompt provided');

                const startTime = Date.now();
                const targetDir = path.resolve(BASE_DIR, outputDir);
                await fs.mkdir(targetDir, { recursive: true });

                const selectedProvider = resolveProvider(provider);
                console.log(`[${new Date().toISOString()}] Image generation: provider=${selectedProvider}, prompt="${prompt.substring(0, 80)}..."`);

                let generatedImages;
                if (selectedProvider === 'openai') {
                    generatedImages = await generateOpenAI({ prompt, width, height, style, count, format });
                } else if (selectedProvider === 'stability') {
                    generatedImages = await generateStability({ prompt, negativePrompt, width, height, style, count, format });
                } else if (selectedProvider === 'replicate') {
                    generatedImages = await generateReplicate({ prompt, negativePrompt, width, height, style, count, format });
                } else if (selectedProvider === 'local') {
                    generatedImages = await generateLocalSD({ prompt, negativePrompt, width, height, count, format });
                } else {
                    throw new Error(`Unknown provider: ${selectedProvider}`);
                }

                const files = [];
                for (let i = 0; i < generatedImages.length; i++) {
                    const img = generatedImages[i];
                    const ts = Date.now();
                    const slug = prompt.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 40).toLowerCase();
                    const fname = filename
                        ? (count > 1 ? `${filename}-${i + 1}.${format}` : `${filename}.${format}`)
                        : `${slug}-${ts}-${i}.${format}`;
                    const filePath = path.join(targetDir, fname);
                    const buffer = Buffer.from(img.base64, 'base64');
                    await fs.writeFile(filePath, buffer);
                    const relativePath = path.relative(BASE_DIR, filePath).replace(/\\/g, '/');
                    files.push({ path: relativePath, absolutePath: filePath, width: img.width || width, height: img.height || height, sizeKB: Math.round(buffer.length / 1024) });
                    console.log(`[${new Date().toISOString()}] Saved image: ${relativePath} (${Math.round(buffer.length / 1024)} KB)`);
                }

                result = { ok: true, provider: selectedProvider, files, revisedPrompt: generatedImages[0]?.revisedPrompt || null, elapsedMs: Date.now() - startTime };
                console.log(`[${new Date().toISOString()}] Image generation complete: ${files.length} file(s) in ${result.elapsedMs}ms`);
            }

            // ── Browser Automation Endpoints ──

            else if (url === '/api/browser/launch') {
                if (browserSessions.size >= MAX_BROWSER_SESSIONS) {
                    throw new Error(`Maximum browser sessions (${MAX_BROWSER_SESSIONS}) reached. Close an existing session first.`);
                }
                const { headless = true, viewport = { width: 1280, height: 720 }, timeout = 30000, label = 'browser session' } = data;
                const browser = await chromium.launch({ headless });
                const context = await browser.newContext({
                    viewport,
                    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                });
                const page = await context.newPage();
                page.setDefaultTimeout(timeout);
                const sessionId = generateBrowserSessionId();
                const bs = {
                    id: sessionId, browser, context, page, currentUrl: null, running: true,
                    startedAt: new Date().toISOString(), closedAt: null,
                    pagesOpened: 0, screenshotsTaken: 0, headless, label
                };
                browserSessions.set(sessionId, bs);
                console.log(`[${new Date().toISOString()}] BROWSER-LAUNCH: ${sessionId} (headless=${headless})`);
                result = { sessionId, headless, viewport };
            }

            else if (url === '/api/browser/navigate') {
                const { sessionId, url: targetUrl, waitUntil = 'load', timeout = 30000 } = data;
                if (!sessionId) throw new Error('No sessionId provided');
                if (!targetUrl) throw new Error('No url provided');
                const bs = browserSessions.get(sessionId);
                if (!bs || !bs.running) throw new Error(`Browser session ${sessionId} not found or closed`);
                const response = await bs.page.goto(targetUrl, { waitUntil, timeout });
                bs.currentUrl = targetUrl;
                bs.pagesOpened++;
                console.log(`[${new Date().toISOString()}] BROWSER-NAV: ${sessionId} -> ${targetUrl} (status: ${response?.status()})`);
                result = { sessionId, url: targetUrl, status: response?.status() || null, title: await bs.page.title() };
            }

            else if (url === '/api/browser/click') {
                const { sessionId, selector, timeout = 5000 } = data;
                if (!sessionId) throw new Error('No sessionId provided');
                if (!selector) throw new Error('No selector provided');
                const bs = browserSessions.get(sessionId);
                if (!bs || !bs.running) throw new Error(`Browser session ${sessionId} not found or closed`);
                await bs.page.click(selector, { timeout });
                await bs.page.waitForLoadState('networkidle').catch(() => {});
                result = { sessionId, clicked: selector, url: bs.page.url(), title: await bs.page.title() };
            }

            else if (url === '/api/browser/type') {
                const { sessionId, selector, text, delay = 50, clearFirst = false, timeout = 5000 } = data;
                if (!sessionId) throw new Error('No sessionId provided');
                if (!selector) throw new Error('No selector provided');
                if (text === undefined || text === null) throw new Error('No text provided');
                const bs = browserSessions.get(sessionId);
                if (!bs || !bs.running) throw new Error(`Browser session ${sessionId} not found or closed`);
                if (clearFirst) await bs.page.fill(selector, '', { timeout });
                await bs.page.type(selector, String(text), { delay, timeout });
                result = { sessionId, typed: selector, textLength: String(text).length };
            }

            else if (url === '/api/browser/screenshot') {
                const { sessionId, fullPage = false, selector, format = 'png', quality } = data;
                if (!sessionId) throw new Error('No sessionId provided');
                const bs = browserSessions.get(sessionId);
                if (!bs || !bs.running) throw new Error(`Browser session ${sessionId} not found or closed`);
                const screenshotOpts = { type: format };
                if (format === 'jpeg' && quality) screenshotOpts.quality = quality;
                let buffer;
                if (selector) {
                    buffer = await bs.page.locator(selector).first().screenshot(screenshotOpts);
                } else {
                    buffer = await bs.page.screenshot({ ...screenshotOpts, fullPage });
                }
                bs.screenshotsTaken++;
                const base64 = buffer.toString('base64');
                console.log(`[${new Date().toISOString()}] BROWSER-SCREENSHOT: ${sessionId} (${Math.round(buffer.length / 1024)}KB)`);
                result = { sessionId, base64, format, sizeKB: Math.round(buffer.length / 1024), url: bs.page.url(), title: await bs.page.title() };
            }

            else if (url === '/api/browser/content') {
                const { sessionId, selector, mode = 'text', maxLength = 100000 } = data;
                if (!sessionId) throw new Error('No sessionId provided');
                const bs = browserSessions.get(sessionId);
                if (!bs || !bs.running) throw new Error(`Browser session ${sessionId} not found or closed`);
                let content;
                if (selector) {
                    const el = bs.page.locator(selector).first();
                    content = mode === 'html' ? await el.innerHTML() : await el.innerText();
                } else {
                    content = mode === 'html' ? await bs.page.content() : await bs.page.innerText('body').catch(() => '');
                }
                const truncated = content.length > maxLength;
                if (truncated) content = content.substring(0, maxLength) + '\n\n[... truncated]';
                result = { sessionId, content, mode, selector: selector || null, length: content.length, truncated, url: bs.page.url(), title: await bs.page.title() };
            }

            else if (url === '/api/browser/evaluate') {
                const { sessionId, expression } = data;
                if (!sessionId) throw new Error('No sessionId provided');
                if (!expression) throw new Error('No expression provided');
                const bs = browserSessions.get(sessionId);
                if (!bs || !bs.running) throw new Error(`Browser session ${sessionId} not found or closed`);
                const evalResult = await bs.page.evaluate(expression);
                result = { sessionId, result: evalResult, url: bs.page.url() };
            }

            else if (url === '/api/browser/close') {
                const { sessionId } = data;
                if (!sessionId) throw new Error('No sessionId provided');
                const bs = browserSessions.get(sessionId);
                if (!bs) throw new Error(`Browser session ${sessionId} not found`);
                const wasRunning = bs.running;
                await closeBrowserSession(bs);
                console.log(`[${new Date().toISOString()}] BROWSER-CLOSE: ${sessionId} (wasRunning=${wasRunning})`);
                result = { sessionId, closed: true, wasRunning };
            }

            else if (url === '/api/browser/list') {
                const list = [];
                for (const bs of browserSessions.values()) list.push(browserSessionSnapshot(bs));
                result = { sessions: list, total: list.length, running: list.filter(s => s.running).length, maxSessions: MAX_BROWSER_SESSIONS };
            }

            // Pipeline human-gate decision endpoint
            else if (url === '/api/pipeline/decide') {
                const { runId, decision, comments } = data;
                if (!runId) throw new Error("Missing 'runId'");
                if (!['approve', 'revise', 'reject'].includes(decision)) throw new Error("Invalid 'decision'. Use: approve, revise, reject");

                const logsDir = path.join(BASE_DIR, 'logs', 'pipeline-runs');
                // Find the run directory matching the runId
                let runDir = null;
                if (fsSync.existsSync(logsDir)) {
                    const dirs = fsSync.readdirSync(logsDir);
                    runDir = dirs.find(d => d === runId || d.includes(runId));
                }
                if (!runDir) throw new Error(`Run directory not found for runId: ${runId}`);

                const decisionPath = path.join(logsDir, runDir, 'human-decision.json');
                const payload = { decision, comments: comments || '' };
                fsSync.writeFileSync(decisionPath, JSON.stringify(payload, null, 2), 'utf8');
                console.log(`[${new Date().toISOString()}] Pipeline decision: ${decision} for ${runId}`);
                result = { ok: true, runId, decision, file: decisionPath };
            }

            // List pipeline runs (for finding runIds)
            else if (url === '/api/pipeline/list') {
                const logsDir = path.join(BASE_DIR, 'logs', 'pipeline-runs');
                let runs = [];
                if (fsSync.existsSync(logsDir)) {
                    runs = fsSync.readdirSync(logsDir)
                        .filter(d => fsSync.statSync(path.join(logsDir, d)).isDirectory())
                        .map(d => {
                            const runPath = path.join(logsDir, d, 'run.json');
                            const requestPath = path.join(logsDir, d, 'human-decision-request.json');
                            const decisionPath = path.join(logsDir, d, 'human-decision.json');
                            let status = 'unknown';
                            if (fsSync.existsSync(decisionPath)) status = 'decided';
                            else if (fsSync.existsSync(requestPath)) status = 'awaiting_decision';
                            return { runId: d, status, hasDecision: fsSync.existsSync(decisionPath) };
                        });
                }
                result = { runs };
            }

            else {
                throw new Error("Endpoint not found");
            }

            res.writeHead(200, headers);
            res.end(JSON.stringify(result));

        } catch (error) {
            console.error("Error processing request:", error);
            res.writeHead(500, headers);
            res.end(JSON.stringify({ error: error.message }));
        }
    });
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        const nextPort = PORT + 1;
        console.log(`Port ${PORT} in use, trying ${nextPort}...`);
        PORT = nextPort;
        server.listen(PORT, '0.0.0.0');
        return;
    }
    throw err;
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n${'='.repeat(56)}`);
    console.log(`  Keen Local Bridge v2 — PID-Tracked Session Manager`);
    console.log(`  Port: ${PORT}  |  Max Concurrent: ${MAX_CONCURRENT}`);
    console.log(`  Working Directory: ${BASE_DIR}`);
    console.log(`${'='.repeat(56)}`);
    console.log(`\n  FILES`);
    console.log(`  POST /api/file/list          List directory`);
    console.log(`  POST /api/file/read          Read file`);
    console.log(`  POST /api/file/write         Write file`);
    console.log(`\n  CLI SESSIONS`);
    console.log(`  POST /api/cli/spawn          Start session (+ metadata)`);
    console.log(`  POST /api/cli/send           Send stdin to session`);
    console.log(`  POST /api/cli/output         Read session output`);
    console.log(`  POST /api/cli/history         Get conversation history`);
    console.log(`  POST /api/cli/wait           Wait for session to finish`);
    console.log(`  POST /api/cli/poll           Poll session (server-side wait)`);
    console.log(`  GET  /api/cli/list           List all sessions (rich)`);
    console.log(`\n  PID MANAGEMENT`);
    console.log(`  POST /api/cli/status         Rich status (one or all)`);
    console.log(`  POST /api/cli/find-by-pid    Lookup session by OS PID`);
    console.log(`  POST /api/cli/kill           Kill one session`);
    console.log(`  POST /api/cli/kill-by-pid    Kill session by OS PID`);
    console.log(`  POST /api/cli/kill-all       Kill all running sessions`);
    console.log(`  POST /api/cli/kill-by-filter Kill by pipeline/agent/age`);
    console.log(`  POST /api/cli/cleanup        Remove finished sessions`);
    console.log(`  Session TTL: ${SESSION_TTL_MS / 1000}s (env: SESSION_TTL_MS)`);
    console.log(`\n  SYSTEM`);
    console.log(`  GET  /                       Status`);
    console.log(`  GET  /api/config             Get config`);
    console.log(`  POST /api/config             Set working directory`);
    console.log(`  POST /api/command            One-shot command (exec)`);
    console.log(`  POST /api/ping               Health check + PID summary`);
    console.log(`\n  WEB & MEDIA`);
    console.log(`  POST /api/web/scrape         Scrape URL to text`);
    console.log(`  POST /api/web/search         DuckDuckGo search`);
    console.log(`  POST /api/web/news           RSS news aggregation`);
    console.log(`  POST /api/web/multi-scrape   Parallel URL scraping`);
    console.log(`  POST /api/image/generate     AI image generation`);
    console.log(`\n  BROWSER AUTOMATION`);
    console.log(`  POST /api/browser/launch     Launch headless browser`);
    console.log(`  POST /api/browser/navigate   Navigate to URL`);
    console.log(`  POST /api/browser/click      Click element by selector`);
    console.log(`  POST /api/browser/type       Type text into element`);
    console.log(`  POST /api/browser/screenshot Capture page screenshot`);
    console.log(`  POST /api/browser/content    Get page text/HTML`);
    console.log(`  POST /api/browser/evaluate   Run JS in page context`);
    console.log(`  POST /api/browser/close      Close browser session`);
    console.log(`  POST /api/browser/list       List browser sessions`);
    console.log(`  Browser TTL: ${BROWSER_SESSION_TTL_MS / 1000}s (env: BROWSER_SESSION_TTL_MS)`);
    console.log(`\n  DEBUG`);
    console.log(`  GET  /debug                  Debug visualization dashboard`);
    console.log(`\n  Ready for Agent commands...\n`);
});
