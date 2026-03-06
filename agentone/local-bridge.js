import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { exec, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const DEFAULT_PORT = 3222;
let PORT = parseInt(process.argv[2] || process.env.BRIDGE_PORT) || DEFAULT_PORT;
const API_TOKEN = 'b3d6d5c1a50155e207c503102f7bc610';
let BASE_DIR = process.cwd();
const IS_WINDOWS = process.platform === 'win32';

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

function createSession(cli, args, cwd, metadata = {}) {
    const running = getRunningCount();
    if (running >= MAX_CONCURRENT) {
        console.log(`[${new Date().toISOString()}] WARNING: ${running}/${MAX_CONCURRENT} sessions running. Killing oldest.`);
        killOldestSession();
    }

    const sessionId = generateSessionId();

    console.log(`[${new Date().toISOString()}] Spawn: ${cli} [${args.length} args]`);

    const proc = spawn(cli, args, {
        cwd: cwd || BASE_DIR,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        env: { ...process.env, CLAUDECODE: undefined, PATH: process.env.PATH }
    });

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
    if (expired > 0) {
        console.log(`[${new Date().toISOString()}] TTL-CLEANUP: Removed ${expired} expired session(s). Remaining: ${sessions.size}`);
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
<title>AgentOne Debug Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f1117;color:#e1e4e8}
.header{background:#161b22;border-bottom:1px solid #30363d;padding:16px 24px;display:flex;justify-content:space-between;align-items:center}
.header h1{font-size:18px;color:#58a6ff}
.stats{display:flex;gap:16px}
.stat{background:#21262d;padding:8px 16px;border-radius:6px;font-size:13px}
.stat .value{font-weight:bold;color:#58a6ff}
.controls{padding:12px 24px;background:#161b22;border-bottom:1px solid #30363d;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.controls button{background:#21262d;color:#c9d1d9;border:1px solid #30363d;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:12px}
.controls button:hover{background:#30363d}
.controls button.danger{border-color:#f85149;color:#f85149}
.controls button.danger:hover{background:#f85149;color:#fff}
.container{padding:16px 24px}
.session-card{background:#161b22;border:1px solid #30363d;border-radius:8px;margin-bottom:12px;overflow:hidden}
.session-header{padding:12px 16px;display:flex;justify-content:space-between;align-items:center;cursor:pointer}
.session-header:hover{background:#1c2128}
.session-status{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px}
.session-status.running{background:#3fb950;animation:pulse 2s infinite}
.session-status.finished{background:#8b949e}
.session-status.error{background:#f85149}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.session-meta{font-size:12px;color:#8b949e;display:flex;gap:12px;align-items:center}
.session-body{display:none;border-top:1px solid #30363d;padding:16px}
.session-body.expanded{display:block}
.agent-badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
.agent-Worker{background:#1f6feb33;color:#58a6ff}
.agent-Judge{background:#8957e533;color:#bc8cff}
.agent-TeamLead{background:#3fb95033;color:#3fb950}
.agent-Reviewer{background:#d2992233;color:#d29922}
.agent-default{background:#21262d;color:#8b949e}
.conversation{margin-top:12px}
.msg{padding:8px 12px;margin:4px 0;border-radius:6px;font-size:13px;white-space:pre-wrap;max-height:300px;overflow-y:auto;word-break:break-word}
.msg.user{background:#0d1117;border-left:3px solid #58a6ff}
.msg.assistant{background:#0d1117;border-left:3px solid #3fb950}
.msg-label{font-size:11px;font-weight:bold;margin-bottom:4px}
.msg-label.user{color:#58a6ff}
.msg-label.assistant{color:#3fb950}
.kill-btn{background:none;border:1px solid #f85149;color:#f85149;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px}
.kill-btn:hover{background:#f85149;color:#fff}
.raw-output{background:#0d1117;padding:12px;border-radius:6px;font-family:'Cascadia Code',monospace;font-size:12px;white-space:pre-wrap;max-height:400px;overflow-y:auto;margin-top:8px;word-break:break-word}
.refresh-indicator{color:#3fb950;font-size:12px}
.filter-bar{display:flex;gap:8px;align-items:center}
.filter-bar select,.filter-bar input{background:#0d1117;color:#c9d1d9;border:1px solid #30363d;padding:4px 8px;border-radius:4px;font-size:12px}
.empty-state{color:#8b949e;padding:40px;text-align:center}
</style>
</head>
<body>
<div class="header">
    <h1>AgentOne Debug Dashboard</h1>
    <div class="stats">
        <div class="stat">Total: <span class="value" id="stat-total">0</span></div>
        <div class="stat">Running: <span class="value" id="stat-running">0</span></div>
        <div class="stat">Max: <span class="value">${MAX_CONCURRENT}</span></div>
        <div class="stat refresh-indicator" id="last-refresh">--</div>
    </div>
</div>
<div class="controls">
    <div class="filter-bar">
        <label style="font-size:12px">Filter:</label>
        <select id="filter-status"><option value="all">All</option><option value="running">Running</option><option value="finished">Finished</option></select>
        <select id="filter-agent"><option value="all">All Agents</option></select>
        <input type="text" id="filter-search" placeholder="Search label/id..." />
    </div>
    <button onclick="refreshData()">Refresh Now</button>
    <button class="danger" onclick="killAll()">Kill All</button>
    <button class="danger" onclick="cleanupSessions()">Cleanup Finished</button>
    <label style="font-size:12px"><input type="checkbox" id="auto-refresh" checked /> Auto (5s)</label>
</div>
<div class="container" id="sessions-container">
    <p class="empty-state">Loading sessions...</p>
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
        document.getElementById('last-refresh').textContent='Updated: '+new Date().toLocaleTimeString();
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
    if(!f.length){c.innerHTML='<p class="empty-state">No sessions match filters.</p>';return}
    f.sort((a,b)=>{if(a.running!==b.running)return a.running?-1:1;return new Date(b.startedAt)-new Date(a.startedAt)});
    c.innerHTML=f.map(s=>renderCard(s)).join('');
}

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}

function renderCard(s){
    const sc=s.running?'running':(s.exitCode!==0?'error':'finished');
    const ac='agent-'+(s.agentType||'default');
    const ex=expandedSessions.has(s.id);
    const rt=s.runtimeSeconds>=60?Math.floor(s.runtimeSeconds/60)+'m '+(s.runtimeSeconds%60)+'s':s.runtimeSeconds+'s';
    return '<div class="session-card">'
        +'<div class="session-header" onclick="toggle(\\''+s.id+'\\')">'
        +'<div><span class="session-status '+sc+'"></span>'
        +'<span class="agent-badge '+ac+'">'+(s.agentType||'unknown')+'</span>'
        +'<strong style="margin-left:8px">'+esc(s.label||s.id)+'</strong></div>'
        +'<div class="session-meta"><span>PID: '+s.pid+'</span><span>'+rt+'</span><span>'+((s.stdoutLength/1024).toFixed(1))+'KB</span>'
        +(s.running?'<button class="kill-btn" onclick="event.stopPropagation();killSession(\\''+s.id+'\\')">Kill</button>':'')
        +'</div></div>'
        +'<div class="session-body '+(ex?'expanded':'')+'" id="body-'+s.id+'">'
        +'<div style="font-size:12px;color:#8b949e;margin-bottom:8px">ID: '+s.id+' | CLI: '+s.cli+' | Pipeline: '+(s.pipelineRunId||'-')+' | Subtask: '+(s.subtaskId||'-')+' | Exit: '+(s.exitCode??'running')+'</div>'
        +'<div id="hist-'+s.id+'" style="margin-bottom:8px"></div>'
        +'<div style="font-size:12px;font-weight:bold;color:#8b949e;margin-bottom:4px">Raw Output</div>'
        +'<div class="raw-output" id="raw-'+s.id+'">Loading...</div>'
        +'</div></div>';
}

function toggle(id){
    if(expandedSessions.has(id)){expandedSessions.delete(id)}
    else{expandedSessions.add(id)}
    renderSessions();
    if(expandedSessions.has(id)){loadRaw(id);loadHistory(id)}
}

async function loadRaw(id){
    try{
        const d=await apiFetch('/api/cli/output',{sessionId:id,full:true});
        const el=document.getElementById('raw-'+id);
        if(el)el.textContent=d.stdout||'(no output)';
    }catch(e){const el=document.getElementById('raw-'+id);if(el)el.textContent='Error: '+e.message}
}

async function loadHistory(id){
    const el=document.getElementById('hist-'+id);
    if(!el)return;
    el.innerHTML='<span style="font-size:12px;color:#8b949e">Loading...</span>';
    try{
        const d=await apiFetch('/api/cli/history',{sessionId:id});
        if(d.history&&d.history.pairs&&d.history.pairs.length>0){
            let html='<div class="conversation">';
            d.history.pairs.forEach(p=>{
                if(p.user)html+='<div class="msg-label user">User</div><div class="msg user">'+esc(p.user)+'</div>';
                if(p.assistant)html+='<div class="msg-label assistant">Assistant</div><div class="msg assistant">'+esc(p.assistant)+'</div>';
            });
            html+='</div>';
            let meta=[];
            if(d.history.usage)meta.push('Tokens: in='+(d.history.usage.input_tokens||0)+' out='+(d.history.usage.output_tokens||0));
            if(d.history.cost)meta.push('Cost: $'+d.history.cost.toFixed(4));
            if(d.history.durationMs)meta.push('Duration: '+(d.history.durationMs/1000).toFixed(1)+'s');
            if(d.history.numTurns)meta.push('Turns: '+d.history.numTurns);
            if(meta.length)html+='<div style="font-size:11px;color:#8b949e;margin-top:8px">'+meta.join(' | ')+'</div>';
            el.innerHTML=html;
        }else{
            el.innerHTML='<span style="font-size:12px;color:#8b949e">No structured history (raw output only).</span>';
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
    const normalizedUrl = req.url.replace(/\/+/g, '/');
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

    const authHeader = req.headers['x-api-token'];
    if (authHeader !== API_TOKEN) {
        console.log(`[${new Date().toISOString()}] REJECTED (bad token): ${method} ${normalizedUrl}`);
        return done(403, { error: 'Invalid or missing API token' });
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
                const { cli, args = [], cwd, closeStdin = false, metadata = {} } = data;
                if (!cli) throw new Error("No CLI tool specified. Provide 'cli' field (e.g. 'claude', 'codex')");

                const session = createSession(cli, args, cwd, metadata);

                if (closeStdin) {
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

                if (session.conversationHistory) {
                    result = { sessionId, history: session.conversationHistory, running: session.running, source: 'cached' };
                } else {
                    let parsed = null;
                    const rawStdout = session.stdout.trim();
                    if (rawStdout.startsWith('{')) {
                        try { parsed = JSON.parse(rawStdout); } catch { /* not JSON */ }
                    }

                    if (parsed && parsed.messages) {
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
                    } else if (parsed && parsed.result) {
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
    console.log(`\n  DEBUG`);
    console.log(`  GET  /debug                  Debug visualization dashboard`);
    console.log(`\n  Ready for Agent commands...\n`);
});
