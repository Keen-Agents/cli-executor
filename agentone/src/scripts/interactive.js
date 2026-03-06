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
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SYSTEM_PROMPT_PATH = resolve(__dirname, 'prompts/orchestrator.md');
const HISTORY_FILE = resolve(homedir(), '.keen_history');
const MAX_HISTORY = 500;
const IS_WINDOWS = process.platform === 'win32';

// ── Slash command registry ───────────────────────────────────────────────────
const SLASH_COMMANDS = [
  { cmd: '/model',    args: '[claude|codex]', desc: 'Switch or toggle primary model' },
  { cmd: '/spinner',  args: '[name]',         desc: 'Change spinner style' },
  { cmd: '/clear',    args: '',               desc: 'Clear screen (Ctrl+L)' },
  { cmd: '/help',     args: '',               desc: 'Show available commands' },
  { cmd: '/status',   args: '',               desc: 'Show session status' },
  { cmd: '/save',     args: '[path]',         desc: 'Save conversation to file' },
];

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
const HEADER_LINES = 2;

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
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workdir' && argv[i + 1]) {
      workdir = resolve(argv[i + 1]);
      i++;
    }
  }
  return { workdir };
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

    const proc = spawn('claude', args, {
      cwd: workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      env: { ...process.env }
    });

    if (procRef) procRef.proc = proc;

    if (isFirst) {
      proc.stdin.write(systemPrompt + '\n\n---\n\nUser message: ' + stdinContent);
    } else {
      proc.stdin.write(stdinContent);
    }
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

    // Per-turn output buffer
    this.primaryOutput = '';
    this.pipelineRunning = false;
    this._pipelineProfile = '';

    // Process reference (for kill on Ctrl+C)
    this._primaryProcRef = {};

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
    this.w(a.moveTo(1, 1) + a.clearLine);
    const mc = this.primaryModel === 'claude' ? a.cyan : a.yellow;
    this.w(
      a.magenta(a.bold('\u2731 Keen')) +
      a.dim('  \u00b7  ') + mc(this.primaryModel) +
      a.dim('  \u00b7  ') + a.gray(this.workdir)
    );
    this.w(a.moveTo(2, 1) + a.clearLine + a.dim('\u2500'.repeat(this.cols)));
  }

  setup() {
    this.w(a.altOn);
    this.w(a.clear);
    this.drawHeader();
    this.w(a.scrollRgn(this.scrollStart, this.scrollEnd));
    this.w(a.moveTo(this.scrollStart, 1));
    this.w(a.save);
    this.drawBottom();

    this._onResize = () => {
      this.w(a.scrollRgn(this.scrollStart, this.scrollEnd));
      this.drawBottom();
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
    if (this._onResize) process.stdout.removeListener('resize', this._onResize);
    if (this._onStdinData) process.stdin.removeListener('data', this._onStdinData);

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

    // Park cursor on input line
    this.w(a.moveTo(r - 2, prefixLen + 1 + visibleCursor));
  }

  // ── Slash commands ─────────────────────────────────────────────────────
  handleSlashCommand(text) {
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();

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
      this.scrollWrite('\n');
      return;
    }

    if (cmd === '/status') {
      const turns = Math.floor(this.conversationHistory.length / 2);
      const mc = this.primaryModel === 'claude' ? a.cyan : a.yellow;
      this.scrollWrite(`\n${a.magenta(a.bold('Status'))}\n`);
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

  // Write text into the scroll region (auto-saves cursor position)
  scrollWrite(text) {
    this.w(a.restore);
    this.w(text);
    this.w(a.save);
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

    return {
      prompt,
      profile: profileMatch ? profileMatch[1] : ''
    };
  }

  _stripPipelineTag(text) {
    return text.replace(/<PIPELINE\s+[^>]*?\/>/g, '').trim();
  }

  // ── Pipeline dispatch ──────────────────────────────────────────────────
  async runPipelineFromTag(prompt, profile) {
    const scriptPath = resolve(__dirname, 'pipeline.js');
    const args = [scriptPath, '--prompt', prompt, '--workdir', this.workdir];
    if (profile) args.push('--profile', profile);

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
      shell: true,
      env: { ...process.env }
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
    const frame = SPINNER[this._spinnerFrame % SPINNER.length];
    const elapsed = Math.floor((Date.now() - this._turnStartTime) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    const mc = this.primaryModel === 'claude' ? a.cyan : a.yellow;
    const label = this.pipelineRunning
      ? `pipeline \u00b7 ${this._pipelineProfile}`
      : this.primaryModel;
    // Overwrite spinner line in-place (restore to saved pos, don't re-save)
    this.w(a.restore + a.clearLine + `  ${mc(frame)} ${a.dim(label + ' \u00b7 ' + mm + ':' + ss)}`);
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

    // Run primary model (streams to scroll region)
    const isFirst = this.primaryModel === 'claude' ? this.isFirstClaude : this.isFirstCodex;
    try {
      const result = await runTurn(text, {
        workdir: this.workdir,
        isFirst,
        systemPrompt: this.systemPrompt,
        model: this.primaryModel,
        conversationHistory: this.conversationHistory,
        procRef: this._primaryProcRef,
        onData: (chunk) => {
          this.primaryOutput += chunk;
          this._clearSpinnerLine();
          // Filter out <PIPELINE .../> tag from display
          const display = chunk.replace(/<PIPELINE\s+[^>]*?\/>/g, '');
          if (display) this.scrollWrite(display);
          this.drawBottom();
        }
      });

      // Update isFirst for the primary model
      if (this.primaryModel === 'claude') this.isFirstClaude = false;
      else this.isFirstCodex = false;

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

      // ── Pipeline tag interception ──────────────────────────────────
      const pipelineTag = this._extractPipelineTag(this.primaryOutput);
      if (pipelineTag) {
        const pipelineResult = await this.runPipelineFromTag(pipelineTag.prompt, pipelineTag.profile);

        // Feed result back to dispatcher for summarization
        const summaryPrompt = pipelineResult.success
          ? `The pipeline completed successfully. Here is the pipeline output (last 4000 chars):\n\n${pipelineResult.output.slice(-4000)}\n\nGive the user a brief summary of what was done.`
          : `The pipeline failed with exit code ${pipelineResult.code}. Output:\n\n${pipelineResult.output.slice(-4000)}\n\nExplain what went wrong and suggest next steps.`;

        this._primaryProcRef = {};
        try {
          const followUp = await runTurn(summaryPrompt, {
            workdir: this.workdir,
            isFirst: false,
            systemPrompt: this.systemPrompt,
            model: this.primaryModel,
            conversationHistory: this.conversationHistory,
            procRef: this._primaryProcRef,
            onData: (chunk) => {
              this.scrollWrite(chunk);
              this.drawBottom();
            }
          });

          this.conversationHistory.push({ role: 'user', content: '[pipeline result]' });
          this.conversationHistory.push({ role: 'assistant', content: followUp.output || '' });
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

    // Elapsed time after response
    const elapsed = ((Date.now() - this._turnStartTime) / 1000).toFixed(1);
    const mc = this.primaryModel === 'claude' ? a.cyan : a.yellow;
    this.scrollWrite('\n' + mc(`${elapsed}s`) + '\n\n');

    this._stopSpinner();
    this._primaryProcRef = {};
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
}
