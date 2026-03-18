#!/usr/bin/env node
/**
 * Keen CLI — conversational REPL powered by Claude/Codex as orchestrator.
 *
 * Usage:  node src/scripts/interactive.js [--workdir <dir>]
 *         npm run agent
 *
 * Features:
 *   /model claude|codex   — switch which model answers prompts
 *   /model                — toggle between Claude and Codex
 *   Ctrl+C                — cancel running turn (double-tap to exit)
 *
 * Multi-model coordination (dual-plan, cross-critique, implementation)
 * is handled by the pipeline stages, not the REPL.
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdtempSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SYSTEM_PROMPT_PATH = resolve(__dirname, 'prompts/orchestrator.md');
const HISTORY_FILE = resolve(homedir(), '.keen_history');
const SESSIONS_DIR = resolve(homedir(), '.keen', 'sessions');
const MAX_SESSIONS = 50;
const MAX_HISTORY = 500;
const IS_WINDOWS = process.platform === 'win32';

// ── Slash command registry ───────────────────────────────────────────────────
const SLASH_COMMANDS = [
  { cmd: '/model',    args: '[claude|codex]', desc: 'Switch or toggle primary model' },
  { cmd: '/claude',   args: '',               desc: 'Switch to Claude' },
  { cmd: '/codex',    args: '',               desc: 'Switch to Codex' },
  { cmd: '/sessions', args: '',               desc: 'List saved sessions' },
  { cmd: '/resume',   args: '[id]',            desc: 'Resume a saved session (interactive picker if no id)' },
  { cmd: '/new',      args: '',               desc: 'Start a fresh session' },
  { cmd: '/spinner',  args: '[name]',         desc: 'Change spinner style' },
  { cmd: '/clear',    args: '',               desc: 'Clear screen (Ctrl+L)' },
  { cmd: '/help',     args: '',               desc: 'Show available commands' },
  { cmd: '/status',   args: '',               desc: 'Show session status' },
  { cmd: '/save',     args: '[path]',         desc: 'Save conversation to file' },
];

// ── Keen logo (ANSI block art — light-blue folder with two white "eyes") ─────
// Blue BG fills for straight edges, ▄/▀ half-blocks for smooth top/bottom and
// circular eyes (2-wide ▄▄/▀▀ = visually square due to 1:2 cell aspect ratio).
const _fg = '\x1b[38;2;183;210;238m';   // light blue foreground (edges)
const _bg = '\x1b[48;2;183;210;238m';   // light blue background (body fill)
const _wh = '\x1b[38;2;255;255;255m';   // white foreground (eyes)
const _r  = '\x1b[0m';                  // reset

// 4-row folder logo (8 wide × 4 tall = visual square): tab+top, eyes×2, bottom
const KEEN_LOGO = [
  `${_bg}   ${_r}${_fg}▄▄▄▄▄${_r}`,
  `${_bg}${_wh} ▄▄  ▄▄ ${_r}`,
  `${_bg}${_wh} ▀▀  ▀▀ ${_r}`,
  `${_fg}▀▀▀▀▀▀▀▀${_r}`,
].join('\n');

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const ESC = '\x1b';
const CSI = `${ESC}[`;
const a = {
  clear:       `${CSI}2J${CSI}3J${CSI}H`,
  clearLine:   `${CSI}2K`,
  clearToEnd:  `${CSI}K`,
  moveTo:      (r, c) => `${CSI}${r};${c}H`,
  scrollRgn:   (t, b) => `${CSI}${t};${b}r`,
  resetScroll: `${CSI}r`,
  save:        `${ESC}7`,
  restore:     `${ESC}8`,
  show:        `${CSI}?25h`,
  hide:        `${CSI}?25l`,
  altOn:       `${CSI}?1049h`,
  altOff:      `${CSI}?1049l`,
  bold:        s => `${CSI}1m${s}${CSI}0m`,
  dim:         s => `${CSI}2m${s}${CSI}0m`,
  cyan:        s => `${CSI}36m${s}${CSI}0m`,
  yellow:      s => `${CSI}33m${s}${CSI}0m`,
  green:       s => `${CSI}32m${s}${CSI}0m`,
  magenta:     s => `${CSI}35m${s}${CSI}0m`,
  gray:        s => `${CSI}90m${s}${CSI}0m`,
  red:         s => `${CSI}31m${s}${CSI}0m`,
};

// Spinner styles — rotated per session for variety
const SPINNERS = {
  dots:    ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'],
  arrows:  ['←','↖','↑','↗','→','↘','↓','↙'],
  pulse:   ['◐','◓','◑','◒'],
  orbit:   ['◜ ','◠ ',' ◝',' ◞','◡ ','◟ '],
  blocks:  ['▖','▘','▝','▗'],
  bounce:  ['⠁','⠂','⠄','⡀','⠄','⠂'],
  star:    ['✶','✸','✹','✺','✹','✸'],
  keen:    ['◇','◈','◆','◈'],
};
const SPINNER_NAMES = Object.keys(SPINNERS);
let activeSpinnerName = SPINNER_NAMES[Math.floor(Math.random() * SPINNER_NAMES.length)];
let SPINNER = SPINNERS[activeSpinnerName];
const HEADER_LINES = 4;

const EXIT_HINTS = {
  1: 'general error', 2: 'invalid arguments', 126: 'not executable',
  127: 'command not found', 130: 'interrupted', 137: 'killed (OOM)',
};

// ── Process kill helper ──────────────────────────────────────────────────────
function killProc(proc) {
  if (!proc || proc.exitCode !== null) return;
  try {
    if (IS_WINDOWS && proc.pid) {
      spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore', shell: false });
    } else {
      proc.kill('SIGTERM');
    }
  } catch {}
}

// ── CLI arg parsing ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  let workdir = process.cwd();
  let resumeId = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workdir' && argv[i + 1]) {
      workdir = resolve(argv[i + 1]);
      i++;
    } else if (argv[i] === '--resume') {
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        resumeId = argv[i + 1];
        i++;
      } else {
        resumeId = '__picker__';  // signal to open interactive picker
      }
    }
  }
  return { workdir, resumeId };
}

// ── Run a single orchestrator turn ──────────────────────────────────────────
function runTurn(stdinContent, opts) {
  if (opts.model === 'codex') return runCodexTurn(stdinContent, opts);
  return runClaudeTurn(stdinContent, opts);
}

function runClaudeTurn(stdinContent, { workdir, isFirst, systemPrompt, onData, procRef }) {
  return new Promise((res, rej) => {
    const args = ['-p'];
    if (!isFirst) args.push('--continue');
    args.push('--dangerously-skip-permissions');

    // Pass system prompt via temp file to avoid Windows cmd.exe ~8KB argument limit.
    // --append-system-prompt-file preserves Claude's built-in prompt (including MCP tools)
    // while adding our orchestrator instructions on top.
    let promptFile = null;
    if (isFirst && systemPrompt) {
      const tmpDir = mkdtempSync(join(tmpdir(), 'keen-'));
      promptFile = join(tmpDir, 'system-prompt.txt');
      writeFileSync(promptFile, systemPrompt, 'utf8');
      args.push('--append-system-prompt-file', promptFile);
    }

    const proc = spawn('claude', args, {
      cwd: workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      env: { ...process.env }
    });

    if (procRef) procRef.proc = proc;

    proc.stdin.write(stdinContent);
    proc.stdin.end();
    proc.stdin.on('error', () => {});

    let fullOutput = '';
    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      fullOutput += text;
      if (onData) onData(text);
    });
    proc.stderr.on('data', () => {});
    proc.on('error', rej);
    proc.on('exit', (code) => res({ code: code ?? 0, output: fullOutput }));
  });
}

function runCodexTurn(stdinContent, { workdir, systemPrompt, conversationHistory, onData, procRef }) {
  return new Promise((res, rej) => {
    let fullPrompt;
    if (!conversationHistory || conversationHistory.length === 0) {
      fullPrompt = systemPrompt + '\n\n---\n\nUser message: ' + stdinContent;
    } else {
      fullPrompt = systemPrompt + '\n\n---\n\nConversation so far:\n';
      for (const turn of conversationHistory) {
        fullPrompt += `\n[${turn.role}]: ${turn.content}\n`;
      }
      fullPrompt += `\n[user]: ${stdinContent}\n`;
      fullPrompt += '\nContinue the conversation. Respond to the latest user message.';
    }

    const args = ['exec', '-'];
    const proc = spawn('codex', args, {
      cwd: workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      env: { ...process.env }
    });

    if (procRef) procRef.proc = proc;

    proc.stdin.write(fullPrompt);
    proc.stdin.end();
    proc.stdin.on('error', () => {});

    let fullOutput = '';
    let stderrOutput = '';

    // Don't stream raw Codex output — it echoes the system prompt.
    // Buffer everything, extract just the response on exit.
    proc.stdout.on('data', (chunk) => { fullOutput += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderrOutput += chunk.toString(); });

    proc.on('error', rej);
    proc.on('exit', (code) => {
      // Extract the actual response from Codex output.
      // Codex echoes the prompt, then outputs the response after a marker line.
      const response = extractCodexResponse(fullOutput);
      if (onData && response) onData(response);
      res({ code: code ?? 0, output: response || fullOutput });
    });
  });
}

/**
 * Extract just the model response from Codex stdout.
 *
 * Codex `exec -` output format:
 *   [header: OpenAI Codex vX.X.X ...]
 *   --------
 *   [metadata lines]
 *   --------
 *   user
 *   [echoed prompt]
 *   mcp startup: ...
 *   codex                  <- response starts AFTER this line
 *   [actual response]
 *   tokens used            <- response ends BEFORE this line
 *   N,NNN
 *   [response repeated]
 */
function extractCodexResponse(stdout) {
  const lines = stdout.split('\n');
  let responseStart = -1;
  let responseEnd = lines.length;

  // Find the last standalone "codex" line — response starts after it
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === 'codex') { responseStart = i + 1; break; }
  }

  if (responseStart < 0) return stdout.trim(); // no marker, return as-is

  // Find "tokens used" after the response start
  for (let i = responseStart; i < lines.length; i++) {
    if (lines[i].trim() === 'tokens used') { responseEnd = i; break; }
  }

  return lines.slice(responseStart, responseEnd).join('\n').trim();
}

// ── TUI ──────────────────────────────────────────────────────────────────────
class KeenCLI {
  constructor({ workdir, systemPrompt }) {
    this.workdir = workdir;
    this.systemPrompt = systemPrompt;
    this.busy = false;
    this.input = '';
    this.cursor = 0;
    this.history = this._loadHistory();
    this.histIdx = this.history.length;
    this.savedInput = '';
    this._cleaned = false;

    // ── Model state ──────────────────────────────────────────────
    this.primaryModel = 'claude';
    this.isFirstClaude = true;
    this.isFirstCodex = true;
    this.conversationHistory = [];   // used for Codex context (Claude uses --continue)

    // ── Session persistence ──────────────────────────────────────
    this.sessionId = `keen-${Date.now()}`;
    this._sessionCreated = new Date().toISOString();
    this._ensureSessionsDir();

    // ── Session picker (interactive /resume) ────────────────────
    this._pickerActive = false;
    this._pickerItems = [];     // session objects
    this._pickerIdx = 0;        // highlighted index
    this._pickerScroll = 0;     // scroll offset for long lists

    // Per-turn output buffer
    this.primaryOutput = '';
    this.pipelineRunning = false;
    this._pipelineProfile = '';

    // Process reference (for kill on Ctrl+C)
    this._primaryProcRef = {};

    // Scroll buffer (for resize replay + scrollback)
    this._scrollBuffer = [];
    this._scrollOffset = 0;   // 0 = at bottom, >0 = lines scrolled up

    // Spinner + elapsed time
    this._spinnerFrame = 0;
    this._spinnerInterval = null;
    this._turnStartTime = 0;

    // Event handlers (stored for cleanup)
    this._onResize = null;
    this._onStdinData = null;
  }

  get rows() { return process.stdout.rows || 24; }
  get cols() { return process.stdout.columns || 80; }
  get scrollStart() { return HEADER_LINES + 1; }
  get scrollEnd() { return Math.max(this.rows - 4, this.scrollStart); }

  w(s) { process.stdout.write(s); }
  rule() { return a.dim('─'.repeat(this.cols)); }

  // ── Layout ─────────────────────────────────────────────────────────────
  drawHeader() {
    const mc = this.primaryModel === 'claude' ? a.cyan : a.yellow;
    const logoLines = KEEN_LOGO.split('\n');
    const infoCol = 12;  // column where text starts (right of logo)

    for (let i = 0; i < logoLines.length; i++) {
      this.w(a.moveTo(i + 1, 1) + a.clearLine);
      this.w(' ' + logoLines[i]);
    }
    // Text info to the right of the logo — single line, vertically centered
    this.w(a.moveTo(3, infoCol) +
      a.bold('Keen') + a.dim('  \u00b7  ') + mc(this.primaryModel) +
      a.dim('  \u00b7  ') + a.gray(this.workdir));

    // Separator
    this.w(a.moveTo(HEADER_LINES, 1) + a.clearLine + a.dim('\u2500'.repeat(this.cols)));
  }

  setup() {
    this.w(a.altOn);
    this.w('\x1b[?1000h\x1b[?1006h');  // enable mouse tracking (SGR mode) for wheel scroll
    this.w(a.clear);
    this._prevRows = this.rows;
    this.drawHeader();
    this.w(a.scrollRgn(this.scrollStart, this.scrollEnd));
    this.w(a.moveTo(this.scrollStart, 1));
    this.w(a.save);
    this.drawBottom();

    this._resizeTimer = null;
    this._onResize = () => {
      // Immediately pause spinner to prevent artifacts during resize
      this._spinnerActive = false;
      // Debounce — resize fires many times while dragging
      if (this._resizeTimer) clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => this._handleResize(), 80);
    };
    process.stdout.on('resize', this._onResize);

    this._onStdinData = (d) => this.onKey(d);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', this._onStdinData);
  }

  cleanup() {
    if (this._cleaned) return;
    this._cleaned = true;

    killProc(this._primaryProcRef.proc);

    if (this._spinnerInterval) clearInterval(this._spinnerInterval);
    if (this._resizeTimer) clearTimeout(this._resizeTimer);
    if (this._onResize) process.stdout.removeListener('resize', this._onResize);
    if (this._onStdinData) process.stdin.removeListener('data', this._onStdinData);

    this.w('\x1b[?1000l\x1b[?1006l');  // disable mouse tracking
    this.w(a.resetScroll);
    this.w(a.show);
    this.w(a.altOff);
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch {}
    }
  }

  drawBottom() {
    const r = this.rows;
    const mc = this.primaryModel === 'claude' ? a.cyan : a.yellow;

    this.w(a.hide); // hide cursor to prevent flicker

    // Row r-3: top separator
    this.w(a.moveTo(r - 3, 1) + a.clearLine + this.rule());

    // Row r-2: input line
    this.w(a.moveTo(r - 2, 1) + a.clearLine);
    const prefixLen = 2; // "> "
    const available = Math.max(this.cols - prefixLen - 1, 10);

    let visibleInput = this.input;
    let visibleCursor = this.cursor;
    if (this.input.length > available) {
      const start = Math.max(0, this.cursor - Math.floor(available * 0.7));
      visibleInput = this.input.slice(start, start + available);
      visibleCursor = this.cursor - start;
    }
    this.w(`${mc('\u203A')} ${visibleInput}`);

    // Row r-1: bottom separator
    this.w(a.moveTo(r - 1, 1) + a.clearLine + this.rule());

    // Row r: hints line
    this.w(a.moveTo(r, 1) + a.clearLine);
    if (this.busy) {
      this.w(a.dim(`  ^C to interrupt \u00b7 `) + mc(this.primaryModel));
    } else {
      const suggestions = this.slashSuggestions();
      if (suggestions) {
        this.w(`  ${suggestions}  ${a.dim('Tab')}`);
      } else {
        this.w(
          a.dim('  \u21B5 send \u00b7 ^C cancel \u00b7 ') +
          mc(`/model ${this.primaryModel}`) +
          a.dim(' \u00b7 /help')
        );
      }
    }

    // Park cursor on input line and show it
    this.w(a.moveTo(r - 2, prefixLen + 1 + visibleCursor) + a.show);
  }

  // ── Resize ───────────────────────────────────────────────────────────
  _handleResize() {
    this.w(a.hide);
    // Full reset — clear everything
    this.w(a.resetScroll);
    this.w(a.clear);

    // Rebuild layout
    this.drawHeader();
    this.w(a.scrollRgn(this.scrollStart, this.scrollEnd));

    // Redraw from buffer (respects scroll offset, shows correct viewport)
    this._redrawScrollView();

    // Re-enable spinner if we're in the middle of a turn
    if (this.busy) {
      this._spinnerActive = true;
    }
  }

  // ── Session persistence ──────────────────────────────────────────────
  _ensureSessionsDir() {
    try { if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
  }

  _saveSession() {
    if (this.conversationHistory.length === 0) return;
    const data = {
      id: this.sessionId,
      created: this._sessionCreated,
      updated: new Date().toISOString(),
      preview: this.conversationHistory[0]?.content?.slice(0, 80) || '',
      model: this.primaryModel,
      history: this.conversationHistory
    };
    try {
      writeFileSync(resolve(SESSIONS_DIR, `${this.sessionId}.json`), JSON.stringify(data), 'utf8');
      this._pruneOldSessions();
    } catch {}
  }

  _listSessions() {
    try {
      return readdirSync(SESSIONS_DIR)
        .filter(f => f.endsWith('.json'))
        .sort().reverse()
        .map(f => { try { return JSON.parse(readFileSync(resolve(SESSIONS_DIR, f), 'utf8')); } catch { return null; } })
        .filter(Boolean);
    } catch { return []; }
  }

  _loadSession(partialId) {
    const sessions = this._listSessions();
    return sessions.find(s => s.id.includes(partialId)) || null;
  }

  _pruneOldSessions() {
    try {
      const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json')).sort();
      while (files.length > MAX_SESSIONS) {
        const old = files.shift();
        try { unlinkSync(resolve(SESSIONS_DIR, old)); } catch {}
      }
    } catch {}
  }

  resumeSession(partialId) {
    const session = this._loadSession(partialId);
    if (!session) return false;
    this._saveSession(); // save current session first
    this.sessionId = session.id;
    this._sessionCreated = session.created;
    this.conversationHistory = session.history || [];
    this.primaryModel = session.model || 'claude';
    this.isFirstClaude = true;
    this.isFirstCodex = true;
    return session;
  }

  // ── Slash commands ─────────────────────────────────────────────────────
  handleSlashCommand(text) {
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    // /claude and /codex shortcuts
    if (cmd === '/claude') { this.setPrimaryModel('claude'); return; }
    if (cmd === '/codex')  { this.setPrimaryModel('codex');  return; }

    if (cmd === '/model') {
      const arg = (parts[1] || '').toLowerCase();
      if (arg === 'claude' || arg === 'codex') {
        this.setPrimaryModel(arg);
      } else if (!arg) {
        this.setPrimaryModel(this.primaryModel === 'claude' ? 'codex' : 'claude');
      } else {
        this.scrollWrite(a.yellow(`Unknown model: ${arg}. Use /model claude or /model codex\n`));
      }
      return;
    }

    if (cmd === '/spinner') {
      const arg = (parts[1] || '').toLowerCase();
      if (arg && SPINNERS[arg]) {
        activeSpinnerName = arg;
        SPINNER = SPINNERS[arg];
        this.scrollWrite(a.magenta(`Spinner: ${arg} `) + SPINNERS[arg].join(' ') + '\n');
      } else if (!arg) {
        // Cycle to next spinner
        const idx = (SPINNER_NAMES.indexOf(activeSpinnerName) + 1) % SPINNER_NAMES.length;
        activeSpinnerName = SPINNER_NAMES[idx];
        SPINNER = SPINNERS[activeSpinnerName];
        this.scrollWrite(a.magenta(`Spinner: ${activeSpinnerName} `) + SPINNER.join(' ') + '\n');
      } else {
        this.scrollWrite(a.yellow(`Unknown spinner. Available: ${SPINNER_NAMES.join(', ')}\n`));
      }
      return;
    }

    if (cmd === '/clear') {
      this._scrollBuffer = [];
      this.w(a.clear);
      this.drawHeader();
      this.w(a.scrollRgn(this.scrollStart, this.scrollEnd));
      this.w(a.moveTo(this.scrollStart, 1));
      this.w(a.save);
      this.drawBottom();
      return;
    }

    if (cmd === '/help') {
      this.scrollWrite('\n' + a.magenta(a.bold('Commands')) + '\n');
      for (const { cmd: c, args: ar, desc } of SLASH_COMMANDS) {
        const full = ar ? `${c} ${ar}` : c;
        this.scrollWrite(`  ${a.cyan(full.padEnd(24))} ${a.dim(desc)}\n`);
      }
      this.scrollWrite('\n' + a.magenta(a.bold('Keyboard')) + '\n');
      this.scrollWrite(`  ${a.cyan('Ctrl+L'.padEnd(24))} ${a.dim('Clear screen')}\n`);
      this.scrollWrite(`  ${a.cyan('Ctrl+C'.padEnd(24))} ${a.dim('Cancel turn / Exit')}\n`);
      this.scrollWrite(`  ${a.cyan('Ctrl+U'.padEnd(24))} ${a.dim('Clear input line')}\n`);
      this.scrollWrite(`  ${a.cyan('Ctrl+W'.padEnd(24))} ${a.dim('Delete word backward')}\n`);
      this.scrollWrite(`  ${a.cyan('\u2191\u2193 arrows'.padEnd(24))} ${a.dim('History navigation')}\n`);
      this.scrollWrite(`  ${a.cyan('PgUp / PgDn'.padEnd(24))} ${a.dim('Scroll conversation')}\n`);
      this.scrollWrite(`  ${a.cyan('Shift+\u2191 / Shift+\u2193'.padEnd(24))} ${a.dim('Scroll 3 lines')}\n`);
      this.scrollWrite('\n');
      return;
    }

    if (cmd === '/status') {
      const turns = Math.floor(this.conversationHistory.length / 2);
      const mc = this.primaryModel === 'claude' ? a.cyan : a.yellow;
      this.scrollWrite(`\n${a.magenta(a.bold('Status'))}\n`);
      const shortId = this.sessionId.replace('keen-', '').slice(-8);
      this.scrollWrite(`  ${a.cyan('Session:'.padEnd(14))} ${shortId}\n`);
      this.scrollWrite(`  ${a.cyan('Model:'.padEnd(14))} ${mc(this.primaryModel)}\n`);
      this.scrollWrite(`  ${a.cyan('Spinner:'.padEnd(14))} ${activeSpinnerName} ${SPINNER.join(' ')}\n`);
      this.scrollWrite(`  ${a.cyan('Turns:'.padEnd(14))} ${turns}\n`);
      this.scrollWrite(`  ${a.cyan('History:'.padEnd(14))} ${this.history.length} entries\n`);
      this.scrollWrite(`  ${a.cyan('Workdir:'.padEnd(14))} ${a.gray(this.workdir)}\n`);
      this.scrollWrite('\n');
      return;
    }

    if (cmd === '/save') {
      const path = parts[1] || `keen-session-${Date.now()}.md`;
      const content = this.conversationHistory.map(t =>
        `## ${t.role}\n\n${t.content}\n`
      ).join('\n---\n\n');
      try {
        writeFileSync(resolve(this.workdir, path), content, 'utf8');
        this.scrollWrite(a.green(`Saved to ${path}\n`));
      } catch (err) {
        this.scrollWrite(a.red(`Failed to save: ${err.message}\n`));
      }
      return;
    }

    if (cmd === '/sessions') {
      const sessions = this._listSessions();
      if (sessions.length === 0) {
        this.scrollWrite(a.dim('  No saved sessions yet.\n'));
        return;
      }
      this.scrollWrite('\n' + a.magenta(a.bold('Sessions')) + '\n\n');
      const show = sessions.slice(0, 20);
      for (const s of show) {
        const d = new Date(s.updated);
        const date = d.toLocaleDateString();
        const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const turns = Math.floor((s.history?.length || 0) / 2);
        const shortId = s.id.replace('keen-', '').slice(-8);
        const isCurrent = s.id === this.sessionId ? a.green(' *') : '';
        const preview = (s.preview || '(empty)').slice(0, 50);
        this.scrollWrite(`  ${a.cyan(shortId)}${isCurrent}  ${a.dim(date + ' ' + time)}  ${a.dim(turns + 't')}  ${preview}\n`);
      }
      if (sessions.length > 20) this.scrollWrite(a.dim(`  ... and ${sessions.length - 20} more\n`));
      this.scrollWrite('\n' + a.dim('  /resume to pick interactively, or /resume <id>') + '\n\n');
      return;
    }

    if (cmd === '/resume') {
      const partialId = parts[1];
      if (!partialId) {
        // No args — open interactive session picker
        this._enterPicker();
        return;
      }
      const session = this.resumeSession(partialId);
      if (!session) {
        this.scrollWrite(a.red(`No session matching "${partialId}"\n`));
        return;
      }
      const turns = Math.floor(session.history.length / 2);
      this.scrollWrite(a.green(`\nResumed session (${turns} turns)\n\n`));
      // Show recent conversation for context
      const recent = session.history.slice(-6);
      for (const turn of recent) {
        const prefix = turn.role === 'user' ? a.green('\u203A') : a.cyan('\u25C7');
        const text = turn.content.slice(0, 120) + (turn.content.length > 120 ? '...' : '');
        this.scrollWrite(`  ${prefix} ${a.dim(text)}\n`);
      }
      this.scrollWrite('\n');
      this.drawHeader();
      this.drawBottom();
      return;
    }

    if (cmd === '/new') {
      this._saveSession();
      this.sessionId = `keen-${Date.now()}`;
      this._sessionCreated = new Date().toISOString();
      this.conversationHistory = [];
      this.isFirstClaude = true;
      this.isFirstCodex = true;
      this.scrollWrite(a.green('New session started.\n'));
      this.drawBottom();
      return;
    }

    // Unknown slash command
    this.scrollWrite(a.red(`Unknown command: ${cmd}`) + a.dim(' — type /help for available commands\n'));
  }

  // ── Slash command suggestions ──────────────────────────────────────────
  slashSuggestions() {
    const input = this.input.toLowerCase();
    if (!input.startsWith('/')) return null;
    const matches = SLASH_COMMANDS.filter(c => c.cmd.startsWith(input) && c.cmd !== input);
    if (matches.length === 0) return null;
    return matches.map(c => {
      const ar = c.args ? ` ${a.dim(c.args)}` : '';
      return `${a.cyan(c.cmd)}${ar}`;
    }).join('  ');
  }

  setPrimaryModel(model) {
    this.primaryModel = model;
    this.conversationHistory = [];  // fresh start on model switch

    const mc = model === 'claude' ? a.cyan : a.yellow;
    this.scrollWrite(mc(`\u2731 Switched to ${model}\n`));
    this.drawHeader();
    this.drawBottom();
  }

  // ── Interactive session picker (/resume) ─────────────────────────────────
  _enterPicker() {
    const sessions = this._listSessions().filter(s => s.id !== this.sessionId);
    if (sessions.length === 0) {
      this.scrollWrite(a.dim('  No other sessions to resume.\n'));
      return;
    }
    this._pickerActive = true;
    this._pickerItems = sessions;
    this._pickerIdx = 0;
    this._pickerScroll = 0;
    this._drawPicker();
  }

  _exitPicker(cancelled) {
    this._pickerActive = false;
    // Redraw to clear picker UI
    this._redrawScrollView();
    this.drawBottom();
    if (cancelled) {
      this.scrollWrite(a.dim('  Cancelled.\n'));
    }
  }

  _pickerSelect() {
    const session = this._pickerItems[this._pickerIdx];
    this._pickerActive = false;
    this._redrawScrollView();
    // Actually resume
    const resumed = this.resumeSession(session.id.replace('keen-', '').slice(-8));
    if (!resumed) {
      this.scrollWrite(a.red(`Failed to resume session.\n`));
      this.drawBottom();
      return;
    }
    const turns = Math.floor(resumed.history.length / 2);
    this.scrollWrite(a.green(`\nResumed session (${turns} turns)\n\n`));
    const recent = resumed.history.slice(-6);
    for (const turn of recent) {
      const prefix = turn.role === 'user' ? a.green('\u203A') : a.cyan('\u25C7');
      const text = turn.content.slice(0, 120) + (turn.content.length > 120 ? '...' : '');
      this.scrollWrite(`  ${prefix} ${a.dim(text)}\n`);
    }
    this.scrollWrite('\n');
    this.drawHeader();
    this.drawBottom();
  }

  _drawPicker() {
    const viewHeight = this.scrollEnd - this.scrollStart;
    const maxVisible = Math.max(viewHeight - 4, 3); // leave room for header/footer
    const items = this._pickerItems;

    // Adjust scroll so selected item is visible
    if (this._pickerIdx < this._pickerScroll) {
      this._pickerScroll = this._pickerIdx;
    } else if (this._pickerIdx >= this._pickerScroll + maxVisible) {
      this._pickerScroll = this._pickerIdx - maxVisible + 1;
    }

    this.w(a.hide);
    // Clear scroll region
    for (let i = this.scrollStart; i <= this.scrollEnd; i++) {
      this.w(a.moveTo(i, 1) + a.clearLine);
    }

    let row = this.scrollStart;

    // Title
    this.w(a.moveTo(row, 1) + '  ' + a.magenta(a.bold('Resume a session')) + a.dim(`  (${items.length} saved)`));
    row += 2;

    // Session list
    const end = Math.min(this._pickerScroll + maxVisible, items.length);
    for (let i = this._pickerScroll; i < end; i++) {
      if (row > this.scrollEnd - 2) break;
      const s = items[i];
      const d = new Date(s.updated);
      const date = d.toLocaleDateString();
      const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const turns = Math.floor((s.history?.length || 0) / 2);
      const shortId = s.id.replace('keen-', '').slice(-8);
      const preview = (s.preview || '(empty)').slice(0, Math.max(this.cols - 40, 20));

      const selected = i === this._pickerIdx;
      const pointer = selected ? a.cyan('\u203A ') : '  ';
      const idStr = selected ? a.cyan(a.bold(shortId)) : a.dim(shortId);
      const meta = a.dim(`${date} ${time}  ${turns}t`);
      const prevStr = selected ? preview : a.dim(preview);

      this.w(a.moveTo(row, 1) + `  ${pointer}${idStr}  ${meta}  ${prevStr}`);
      row++;
    }

    // Scroll indicators
    if (this._pickerScroll > 0) {
      this.w(a.moveTo(this.scrollStart + 2, this.cols - 3) + a.dim('\u2191'));
    }
    if (end < items.length) {
      this.w(a.moveTo(row, this.cols - 3) + a.dim('\u2193'));
    }

    // Footer hints
    const footerRow = Math.min(row + 1, this.scrollEnd);
    this.w(a.moveTo(footerRow, 1) + '  ' + a.dim('\u2191\u2193 navigate \u00b7 Enter select \u00b7 Esc cancel'));

    this.w(a.show);
    // Hide main input prompt — park cursor off the input area
    this.w(a.moveTo(this.rows - 2, 1) + a.clearLine + a.dim('  selecting session...'));
    this.w(a.moveTo(this.rows, 1) + a.clearLine + a.dim('  \u2191\u2193 navigate \u00b7 Enter select \u00b7 Esc cancel'));
  }

  _onPickerKey(data) {
    const key = data.toString();
    const hex = data.toString('hex');

    // Escape
    if (key === '\x1b' && hex === '1b') {
      this._exitPicker(true);
      return true;
    }
    // Ctrl+C
    if (key === '\x03') {
      this._exitPicker(true);
      return true;
    }
    // Enter
    if (key === '\r' || key === '\n') {
      this._pickerSelect();
      return true;
    }
    // Up arrow
    if (hex === '1b5b41') {
      if (this._pickerIdx > 0) {
        this._pickerIdx--;
        this._drawPicker();
      }
      return true;
    }
    // Down arrow
    if (hex === '1b5b42') {
      if (this._pickerIdx < this._pickerItems.length - 1) {
        this._pickerIdx++;
        this._drawPicker();
      }
      return true;
    }
    // Page Up (jump 5)
    if (hex === '1b5b357e') {
      this._pickerIdx = Math.max(0, this._pickerIdx - 5);
      this._drawPicker();
      return true;
    }
    // Page Down (jump 5)
    if (hex === '1b5b367e') {
      this._pickerIdx = Math.min(this._pickerItems.length - 1, this._pickerIdx + 5);
      this._drawPicker();
      return true;
    }
    // Consume all other keys (don't leak to main handler)
    return true;
  }

  // Write text into the scroll region (auto-saves cursor position)
  scrollWrite(text) {
    // Buffer for replay on resize + scrollback
    this._scrollBuffer.push(text);
    if (this._scrollBuffer.length > 1000) this._scrollBuffer = this._scrollBuffer.slice(-500);

    if (this._scrollOffset > 0) {
      // Was scrolled up — snap to bottom with full redraw (text already in buffer)
      this._scrollOffset = 0;
      this._redrawScrollView();
      return;
    }

    this.w(a.hide + a.restore);
    this.w(text);
    this.w(a.save + a.show);
  }

  // ── Scrollback (Page Up / Page Down) ──────────────────────────────────
  _getAllDisplayLines() {
    return this._scrollBuffer.join('').split('\n');
  }

  _scrollUp(lines) {
    const allLines = this._getAllDisplayLines();
    const viewHeight = this.scrollEnd - this.scrollStart;
    const step = lines || Math.floor(viewHeight / 2);
    const maxOffset = Math.max(0, allLines.length - viewHeight);
    this._scrollOffset = Math.min(this._scrollOffset + step, maxOffset);
    this._redrawScrollView();
  }

  _scrollDown(lines) {
    const viewHeight = this.scrollEnd - this.scrollStart;
    const step = lines || Math.floor(viewHeight / 2);
    this._scrollOffset = Math.max(0, this._scrollOffset - step);
    this._redrawScrollView();
  }

  _redrawScrollView() {
    const allLines = this._getAllDisplayLines();
    const viewHeight = this.scrollEnd - this.scrollStart;
    const endIdx = allLines.length - this._scrollOffset;
    const startIdx = Math.max(0, endIdx - viewHeight);
    const visible = allLines.slice(startIdx, endIdx);

    this.w(a.hide);
    // Clear scroll region
    for (let i = this.scrollStart; i <= this.scrollEnd; i++) {
      this.w(a.moveTo(i, 1) + a.clearLine);
    }
    // Draw visible lines
    for (let i = 0; i < visible.length; i++) {
      this.w(a.moveTo(this.scrollStart + i, 1) + visible[i]);
    }
    // Scroll indicator when not at bottom
    if (this._scrollOffset > 0) {
      this.w(a.moveTo(this.scrollEnd, this.cols - 12) + a.dim(`\u2191 scroll \u2193`));
    }
    this.w(a.save + a.show);
    this.drawBottom();
  }

  // ── Pipeline tag detection ───────────────────────────────────────────
  _extractPipelineTag(output) {
    const match = output.match(/<PIPELINE\s+([^>]*?)\/>/);
    if (!match) return null;

    const attrs = match[1];
    const promptMatch = attrs.match(/prompt="([^"]*)"/);
    const profileMatch = attrs.match(/profile="([^"]*)"/);
    if (!promptMatch) return null;

    const prompt = promptMatch[1];

    // Reject placeholder/example prompts (from system prompt echo)
    const REJECT = ['TASK_DESCRIPTION', 'your task description here', '...'];
    if (!prompt || prompt.length < 5 || REJECT.includes(prompt)) return null;

    // Parse angles and subtasks (single-quoted JSON to avoid conflicts with double-quote attrs)
    let angles = null;
    let subtasks = null;
    const anglesMatch = attrs.match(/angles='([^']*)'/);
    const subtasksMatch = attrs.match(/subtasks='([^']*)'/);
    if (anglesMatch) {
      try { angles = JSON.parse(anglesMatch[1]); } catch {}
    }
    if (subtasksMatch) {
      try { subtasks = JSON.parse(subtasksMatch[1]); } catch {}
    }

    return {
      prompt,
      profile: profileMatch ? profileMatch[1] : '',
      angles,
      subtasks
    };
  }

  _stripPipelineTag(text) {
    return text.replace(/<PIPELINE\s+[^>]*?\/>/g, '').trim();
  }

  // ── Spawn tag detection ────────────────────────────────────────────────
  _extractSpawnTag(output) {
    const match = output.match(/<SPAWN\s+([^>]*?)\/>/);
    if (!match) return null;

    const attrs = match[1];
    const cliMatch = attrs.match(/cli="([^"]*)"/);
    const promptMatch = attrs.match(/prompt="([^"]*)"/);
    if (!cliMatch || !promptMatch) return null;

    const cli = cliMatch[1].toLowerCase();
    const prompt = promptMatch[1];
    if (!prompt || prompt.length < 2) return null;
    if (cli !== 'claude' && cli !== 'codex') return null;

    return { cli, prompt };
  }

  // ── Spawn dispatch (quick one-shot) ────────────────────────────────────
  async runSpawnFromTag(cli, prompt) {
    const mc = cli === 'claude' ? a.cyan : a.yellow;
    this.scrollWrite('\n' + mc(`\u2731 ${cli}`) + a.dim(` \u00b7 ${prompt.slice(0, 60)}${prompt.length > 60 ? '...' : ''}`) + '\n\n');
    this._turnStartTime = Date.now();
    this._spinnerActive = true;
    this.drawBottom();

    let spawnOutput = '';
    const procRef = {};
    this._primaryProcRef = procRef;

    try {
      const result = await runTurn(prompt, {
        workdir: this.workdir,
        isFirst: true,
        systemPrompt: `You are ${cli}. Answer the following request directly and concisely.`,
        model: cli,
        conversationHistory: [],
        procRef,
        onData: (chunk) => {
          this._clearSpinnerLine();
          spawnOutput += chunk;
          this.scrollWrite(chunk);
          this.drawBottom();
        }
      });

      // If no streaming happened (Codex batches), spawnOutput is from onData in exit
      if (!spawnOutput && result.output) spawnOutput = result.output;

      const elapsed = ((Date.now() - this._turnStartTime) / 1000).toFixed(1);
      this.scrollWrite('\n' + mc(`${elapsed}s`) + '\n');
    } catch (err) {
      this.scrollWrite(a.red(`\nError: ${err.message}\n`));
    }

    this._spinnerActive = false;
    this._primaryProcRef = {};
    this.drawBottom();
    return spawnOutput;
  }

  // ── Pipeline dispatch ──────────────────────────────────────────────────
  async runPipelineFromTag(prompt, profile, angles, subtasks) {
    const scriptPath = resolve(__dirname, 'pipeline.js');
    const args = [scriptPath, '--prompt', prompt, '--workdir', this.workdir];
    if (profile) args.push('--profile', profile);
    if (angles) args.push('--angles', JSON.stringify(angles));
    if (subtasks) args.push('--subtasks', JSON.stringify(subtasks));

    this.pipelineRunning = true;
    this._pipelineProfile = profile || 'auto';
    this._turnStartTime = Date.now(); // reset timer for pipeline phase
    this._spinnerActive = true; // re-enable spinner for pipeline phase

    this.scrollWrite('\n' + a.dim('─'.repeat(Math.min(40, this.cols))) + '\n');
    const label = prompt.length > 60 ? prompt.slice(0, 57) + '...' : prompt;
    this.scrollWrite(a.bold('Pipeline started') + a.dim(` · ${this._pipelineProfile} · ${label}`) + '\n\n');
    this.drawBottom();

    let pipelineOutput = '';

    const proc = spawn('node', args, {
      cwd: this.workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,  // shell:true splits prompt with spaces into separate args
      env: {
        ...process.env,
        BRIDGE_API_TOKEN: process.env.BRIDGE_API_TOKEN || process.env.AGENTONE_API_TOKEN || 'b3d6d5c1a50155e207c503102f7bc610'
      }
    });

    this._primaryProcRef.proc = proc;
    proc.stdin.end();
    proc.stdin.on('error', () => {});

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      pipelineOutput += text;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        if (line.includes('[pipeline]')) {
          this.scrollWrite(a.cyan(line) + '\n');
        } else {
          this.scrollWrite(a.dim(line) + '\n');
        }
      }
      this.drawBottom();
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      pipelineOutput += text;
      this.scrollWrite(a.red(text));
      this.drawBottom();
    });

    const result = await new Promise((res) => {
      proc.on('error', (err) => res({ code: 1, success: false, error: err.message }));
      proc.on('exit', (code) => res({ code: code ?? 1, success: code === 0 }));
    });

    this.pipelineRunning = false;
    this._stopSpinner();
    this._primaryProcRef = {};

    this.scrollWrite('\n' + (result.success
      ? a.green('Pipeline completed.')
      : a.red(`Pipeline exited with code ${result.code}.`)) + '\n');
    this.scrollWrite(a.dim('─'.repeat(Math.min(40, this.cols))) + '\n\n');
    this.drawBottom();

    return { ...result, output: pipelineOutput };
  }

  // ── Spinner (renders in scroll area, not bottom bar) ─────────────────
  _startSpinner() {
    // Stop any existing spinner interval to prevent leaks
    if (this._spinnerInterval) {
      clearInterval(this._spinnerInterval);
      this._spinnerInterval = null;
    }
    this._spinnerFrame = 0;
    this._turnStartTime = Date.now();
    this._spinnerActive = true;
    this._spinnerInterval = setInterval(() => {
      this._spinnerFrame++;
      if (this._spinnerActive) this._drawSpinnerInScroll();
      this.drawBottom();
    }, 120);
  }

  _drawSpinnerInScroll() {
    if (this._scrollOffset > 0) return;  // don't overwrite when user is scrolled up
    const frame = SPINNER[this._spinnerFrame % SPINNER.length];
    const elapsed = Math.floor((Date.now() - this._turnStartTime) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    const mc = this.primaryModel === 'claude' ? a.cyan : a.yellow;
    const label = this.pipelineRunning
      ? `pipeline \u00b7 ${this._pipelineProfile}`
      : this.primaryModel;
    // Overwrite spinner line in-place (restore to saved pos, don't re-save)
    this.w(a.hide + a.restore + a.clearLine + `  ${mc(frame)} ${a.dim(label + ' \u00b7 ' + mm + ':' + ss)}` + a.show);
  }

  _clearSpinnerLine() {
    if (!this._spinnerActive) return;
    this._spinnerActive = false;
    // Clear the spinner line and save position for normal streaming
    this.w(a.restore + a.clearLine + a.save);
  }

  _stopSpinner() {
    this._spinnerActive = false;
    if (this._spinnerInterval) {
      clearInterval(this._spinnerInterval);
      this._spinnerInterval = null;
    }
  }

  // ── Submit ─────────────────────────────────────────────────────────────
  async submit() {
    const text = this.input.trim();
    if (!text || this.busy) return;

    // Slash commands — all / prefixed input is treated as a command
    if (text.startsWith('/')) {
      this.handleSlashCommand(text);
      this.input = '';
      this.cursor = 0;
      this.drawBottom();
      return;
    }

    // Deduplicate adjacent history entries
    if (!this.history.length || this.history[this.history.length - 1] !== text) {
      this.history.push(text);
      if (this.history.length > MAX_HISTORY) this.history.shift();
      try { appendFileSync(HISTORY_FILE, text + '\n'); } catch {}
    }
    this.histIdx = this.history.length;
    this.input = '';
    this.cursor = 0;
    this.busy = true;

    // Reset per-turn buffers
    this.primaryOutput = '';
    this._primaryProcRef = {};

    this._startSpinner();
    this.drawBottom();

    // User prompt echo
    this.scrollWrite(`\n${a.green(a.bold('\u203A'))} ${a.bold(text)}\n\n`);

    // Run primary model — buffer output, display only if no dispatch tags
    const isFirst = this.primaryModel === 'claude' ? this.isFirstClaude : this.isFirstCodex;

    // When resuming a session, give Claude context of the previous conversation
    let modelInput = text;
    if (isFirst && this.conversationHistory.length > 0 && this.primaryModel === 'claude') {
      const ctx = this.conversationHistory.slice(-10).map(t =>
        `[${t.role}]: ${t.content.slice(0, 500)}`
      ).join('\n\n');
      modelInput = `[Resumed session — previous conversation for context]\n${ctx}\n\n[Current message]\n${text}`;
    }

    try {
      const result = await runTurn(modelInput, {
        workdir: this.workdir,
        isFirst,
        systemPrompt: this.systemPrompt,
        model: this.primaryModel,
        conversationHistory: this.conversationHistory,
        procRef: this._primaryProcRef,
        onData: (chunk) => {
          this.primaryOutput += chunk;
          // Buffer everything — display decision happens after model finishes.
          // Spinner keeps running to show activity.
        }
      });

      // Update isFirst for the primary model
      if (this.primaryModel === 'claude') this.isFirstClaude = false;
      else this.isFirstCodex = false;

      // Check for dispatch tags
      const spawnTag = this._extractSpawnTag(this.primaryOutput);
      const pipelineTag = this._extractPipelineTag(this.primaryOutput);

      // Display buffered output only if it's a plain conversational response
      if (!spawnTag && !pipelineTag) {
        this._clearSpinnerLine();
        const display = this.primaryOutput;
        if (display.trim()) this.scrollWrite(display);

        const elapsed = ((Date.now() - this._turnStartTime) / 1000).toFixed(1);
        const mc = this.primaryModel === 'claude' ? a.cyan : a.yellow;
        this.scrollWrite('\n' + mc(`${elapsed}s`) + '\n\n');
      }

      // Track conversation (used by Codex for context; Claude uses --continue)
      this.conversationHistory.push({ role: 'user', content: text });
      this.conversationHistory.push({ role: 'assistant', content: this.primaryOutput || result.output });
      if (this.conversationHistory.length > 20) {
        this.conversationHistory = this.conversationHistory.slice(-20);
      }

      if (result.code !== 0) {
        const hint = EXIT_HINTS[result.code] || '';
        this.scrollWrite(a.dim(`\n[keen] exit code ${result.code}${hint ? ': ' + hint : ''}\n`));
      }

      // ── Spawn tag interception (quick one-shot) ──────────────────
      if (spawnTag) {
        const spawnResult = await this.runSpawnFromTag(spawnTag.cli, spawnTag.prompt);

        // Track in conversation history (no relay — user already saw the response)
        const modelName = spawnTag.cli === 'claude' ? 'Claude' : 'Codex';
        this.conversationHistory.push({
          role: 'assistant',
          content: `[${modelName} said: ${(spawnResult || '(no output)').slice(0, 500)}]`
        });
        if (this.conversationHistory.length > 20) {
          this.conversationHistory = this.conversationHistory.slice(-20);
        }
      }

      // ── Pipeline tag interception (full multi-stage) ──────────────
      if (pipelineTag) {
        this._clearSpinnerLine();
        const pipelineResult = await this.runPipelineFromTag(pipelineTag.prompt, pipelineTag.profile, pipelineTag.angles, pipelineTag.subtasks);

        // Feed result back to dispatcher for summarization
        const summaryPrompt = pipelineResult.success
          ? `The pipeline completed successfully. Here is the pipeline output (last 4000 chars):\n\n${pipelineResult.output.slice(-4000)}\n\nGive the user a brief summary of what was done.`
          : `The pipeline failed with exit code ${pipelineResult.code}. Output:\n\n${pipelineResult.output.slice(-4000)}\n\nExplain what went wrong and suggest next steps.`;

        this._primaryProcRef = {};
        this._startSpinner();
        try {
          let followUpOutput = '';
          const followUp = await runTurn(summaryPrompt, {
            workdir: this.workdir,
            isFirst: false,
            systemPrompt: this.systemPrompt,
            model: this.primaryModel,
            conversationHistory: this.conversationHistory,
            procRef: this._primaryProcRef,
            onData: (chunk) => {
              followUpOutput += chunk;
              this._clearSpinnerLine();
              this.scrollWrite(chunk);
              this.drawBottom();
            }
          });

          this.conversationHistory.push({ role: 'user', content: '[pipeline result]' });
          this.conversationHistory.push({ role: 'assistant', content: followUpOutput || followUp.output || '' });
          if (this.conversationHistory.length > 20) {
            this.conversationHistory = this.conversationHistory.slice(-20);
          }
        } catch (err) {
          this.scrollWrite(a.dim(`\n[keen] summary error: ${err.message}\n`));
        }
      }
    } catch (err) {
      this.scrollWrite(a.dim(`\n[keen] error: ${err.message}\n`));
    }

    this._stopSpinner();
    this._primaryProcRef = {};
    this._saveSession();
    this.busy = false;
    this.drawBottom();
  }

  // ── Cancel running turn ────────────────────────────────────────────────
  cancelTurn() {
    killProc(this._primaryProcRef.proc);
    this._primaryProcRef = {};

    this._stopSpinner();
    this.busy = false;

    this.scrollWrite(a.yellow('\n[keen] Turn cancelled.\n'));
    this.drawBottom();
  }

  // ── History persistence ────────────────────────────────────────────────
  _loadHistory() {
    try {
      if (!existsSync(HISTORY_FILE)) return [];
      const lines = readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
      return lines.slice(-MAX_HISTORY);
    } catch { return []; }
  }

  // ── Keyboard ───────────────────────────────────────────────────────────
  onKey(data) {
    // Session picker intercepts all keys when active
    if (this._pickerActive) {
      this._onPickerKey(data);
      return;
    }

    const key = data.toString();

    // Ctrl+C: cancel turn if busy, exit if idle
    if (key === '\x03') {
      if (this.busy) {
        this.cancelTurn();
        return;
      }
      this.cleanup();
      const turns = Math.floor(this.conversationHistory.length / 2);
      console.log(a.dim(`[keen] ${turns} turn${turns !== 1 ? 's' : ''} completed. Goodbye.`));
      process.exit(0);
    }

    // Ctrl+T — reserved for future use
    if (key === '\x14') return;

    // Mouse wheel scroll (SGR mode) — works even while model is generating
    const sgrMouseMatch = key.match(/\x1b\[<(\d+);\d+;\d+[Mm]/);
    if (sgrMouseMatch) {
      const button = parseInt(sgrMouseMatch[1]);
      if (button === 64) this._scrollUp(3);   // wheel up
      if (button === 65) this._scrollDown(3);  // wheel down
      return;
    }

    if (this.busy) return;

    const hex = data.toString('hex');

    // Enter
    if (key === '\r' || key === '\n') { this.submit(); return; }

    // Tab — autocomplete slash commands
    if (key === '\t') {
      if (this.input.startsWith('/')) {
        const input = this.input.toLowerCase();
        const matches = SLASH_COMMANDS.filter(c => c.cmd.startsWith(input) && c.cmd !== input);
        if (matches.length === 1) {
          this.input = matches[0].cmd + (matches[0].args ? ' ' : '');
          this.cursor = this.input.length;
          this.drawBottom();
        } else if (matches.length > 1) {
          let common = matches[0].cmd;
          for (let i = 1; i < matches.length; i++) {
            while (!matches[i].cmd.startsWith(common)) {
              common = common.slice(0, -1);
            }
          }
          if (common.length > this.input.length) {
            this.input = common;
            this.cursor = this.input.length;
            this.drawBottom();
          }
        }
      }
      return;
    }

    // Backspace (0x7f Unix, 0x08 Windows)
    if (key === '\x7f' || hex === '08') {
      if (this.cursor > 0) {
        this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor);
        this.cursor--;
        this.drawBottom();
      }
      return;
    }

    // Ctrl+L — clear screen + redraw header
    if (key === '\x0c') {
      this._scrollBuffer = [];
      this.w(a.clear);
      this.drawHeader();
      this.w(a.scrollRgn(this.scrollStart, this.scrollEnd));
      this.w(a.moveTo(this.scrollStart, 1));
      this.w(a.save);
      this.drawBottom();
      return;
    }

    // Ctrl+A — home
    if (key === '\x01') { this.cursor = 0; this.drawBottom(); return; }

    // Ctrl+E — end
    if (key === '\x05') { this.cursor = this.input.length; this.drawBottom(); return; }

    // Ctrl+U — clear input
    if (key === '\x15') { this.input = ''; this.cursor = 0; this.drawBottom(); return; }

    // Ctrl+W — delete word backward
    if (key === '\x17') {
      const before = this.input.slice(0, this.cursor).replace(/\s*\S+\s*$/, '');
      this.input = before + this.input.slice(this.cursor);
      this.cursor = before.length;
      this.drawBottom();
      return;
    }

    // Ctrl+K — delete to end of line
    if (key === '\x0b') {
      this.input = this.input.slice(0, this.cursor);
      this.drawBottom();
      return;
    }

    // Escape sequences (arrows, home, end, delete)
    if (hex.startsWith('1b5b') || hex.startsWith('1b4f')) {
      // Up
      if (hex === '1b5b41') {
        if (!this.history.length) return;
        if (this.histIdx === this.history.length) this.savedInput = this.input;
        if (this.histIdx > 0) {
          this.histIdx--;
          this.input = this.history[this.histIdx];
          this.cursor = this.input.length;
          this.drawBottom();
        }
        return;
      }
      // Down
      if (hex === '1b5b42') {
        if (this.histIdx < this.history.length) {
          this.histIdx++;
          this.input = this.histIdx === this.history.length ? this.savedInput : this.history[this.histIdx];
          this.cursor = this.input.length;
          this.drawBottom();
        }
        return;
      }
      // Left
      if (hex === '1b5b44') {
        if (this.cursor > 0) { this.cursor--; this.drawBottom(); }
        return;
      }
      // Right
      if (hex === '1b5b43') {
        if (this.cursor < this.input.length) { this.cursor++; this.drawBottom(); }
        return;
      }
      // Home
      if (hex === '1b5b48' || hex === '1b4f48') {
        this.cursor = 0; this.drawBottom(); return;
      }
      // End
      if (hex === '1b5b46' || hex === '1b4f46') {
        this.cursor = this.input.length; this.drawBottom(); return;
      }
      // Delete
      if (hex === '1b5b337e') {
        if (this.cursor < this.input.length) {
          this.input = this.input.slice(0, this.cursor) + this.input.slice(this.cursor + 1);
          this.drawBottom();
        }
        return;
      }
      // Page Up — scroll back through history
      if (hex === '1b5b357e') { this._scrollUp(); return; }
      // Page Down — scroll forward
      if (hex === '1b5b367e') { this._scrollDown(); return; }
      // Shift+Up — scroll up one line
      if (hex === '1b5b313b3241') { this._scrollUp(3); return; }
      // Shift+Down — scroll down one line
      if (hex === '1b5b313b3242') { this._scrollDown(3); return; }
      return; // silently ignore unknown escape sequences
    }

    // Ignore non-printable control characters
    if (key.charCodeAt(0) < 32) return;

    // Printable characters — strip newlines from paste operations
    const clean = key.replace(/[\r\n]/g, ' ');
    this.input = this.input.slice(0, this.cursor) + clean + this.input.slice(this.cursor);
    this.cursor += clean.length;
    this.drawBottom();
  }
}

// ── Keen framework integration (single-shot) ─────────────────────────────────
export async function exec(dictionary) {
  const prompt = dictionary?.prompt || dictionary?.message || '';
  const workdir = dictionary?.workDir || dictionary?.workingDirectory || process.cwd();
  if (!prompt) throw new Error('exec() requires dictionary.prompt or dictionary.message');

  const systemPrompt = readFileSync(SYSTEM_PROMPT_PATH, 'utf8');
  const { runAgent } = await import('./lib/agent-runner.js');
  const result = await runAgent({
    cli: 'claude',
    prompt: `${systemPrompt}\n\n---\n\nUser request: ${prompt}`,
    cwd: workdir,
    timeout: 900_000,
    label: 'orchestrator',
    metadata: { agentType: 'orchestrator' }
  });

  if (dictionary && typeof dictionary === 'object') {
    dictionary.response = result.fullOutput || result.content || '';
  }
  return result;
}

// ── Direct invocation ────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  let systemPrompt;
  try {
    systemPrompt = readFileSync(SYSTEM_PROMPT_PATH, 'utf8');
  } catch (err) {
    console.error(`[keen] Cannot read orchestrator prompt: ${err.message}`);
    process.exit(1);
  }

  const cli = new KeenCLI({ workdir: args.workdir, systemPrompt });

  // Resume a previous session if --resume was passed
  if (args.resumeId && args.resumeId !== '__picker__') {
    const session = cli.resumeSession(args.resumeId);
    if (session) {
      const turns = Math.floor(session.history.length / 2);
      console.log(`[keen] Resumed session (${turns} turns): ${session.preview || '(no preview)'}`);
    } else {
      console.error(`[keen] No session matching "${args.resumeId}"`);
      process.exit(1);
    }
  }
  // --resume with no id: open interactive picker after TUI is set up
  const _openPickerOnStart = args.resumeId === '__picker__';

  const shutdown = () => { cli.cleanup(); process.exit(0); };
  process.on('exit', () => cli.cleanup());
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('uncaughtException', (err) => {
    cli.cleanup();
    console.error('[keen] Fatal:', err.message);
    process.exit(1);
  });
  process.stdout.on('error', (err) => {
    if (err.code === 'EPIPE') process.exit(0);
  });

  cli.setup();

  // Open picker immediately if --resume was passed with no id
  if (_openPickerOnStart) {
    cli._enterPicker();
  }
}
