#!/usr/bin/env node
/**
 * Keen CLI — conversational REPL powered by Claude as orchestrator.
 *
 * Usage:  node src/scripts/interactive.js [--workdir <dir>]
 *         npm run agent
 *
 * TUI with scroll region for output, fixed input area + status bar at bottom.
 * Raw keyboard handling with history, cursor movement, and standard shortcuts.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SYSTEM_PROMPT_PATH = resolve(__dirname, 'prompts/orchestrator.md');

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const ESC = '\x1b';
const CSI = `${ESC}[`;
const a = {
  clear:       `${CSI}2J${CSI}H`,
  clearLine:   `${CSI}2K`,
  clearToEnd:  `${CSI}K`,
  moveTo:      (r, c) => `${CSI}${r};${c}H`,
  scrollRgn:   (t, b) => `${CSI}${t};${b}r`,
  resetScroll: `${CSI}r`,
  save:        `${ESC}7`,
  restore:     `${ESC}8`,
  show:        `${CSI}?25h`,
  hide:        `${CSI}?25l`,
  bold:        s => `${CSI}1m${s}${CSI}0m`,
  dim:         s => `${CSI}2m${s}${CSI}0m`,
  cyan:        s => `${CSI}36m${s}${CSI}0m`,
  yellow:      s => `${CSI}33m${s}${CSI}0m`,
  green:       s => `${CSI}32m${s}${CSI}0m`,
  magenta:     s => `${CSI}35m${s}${CSI}0m`,
  gray:        s => `${CSI}90m${s}${CSI}0m`,
};

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

// ── Run a single orchestrator turn via `claude -p` ───────────────────────────
// System prompt is injected via stdin on the first turn (not --system-prompt)
// because Windows cmd.exe mangles pipes, backticks, and quotes in CLI args.
function runTurn(stdinContent, { workdir, isFirst, systemPrompt }) {
  return new Promise((res, rej) => {
    const args = ['-p'];
    if (!isFirst) {
      args.push('--continue');
    }
    args.push('--dangerously-skip-permissions');

    const proc = spawn('claude', args, {
      cwd: workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      env: { ...process.env }
    });

    // First turn: prepend system prompt to the user message via stdin
    // so it's part of the conversation context for --continue turns.
    if (isFirst) {
      proc.stdin.write(systemPrompt + '\n\n---\n\nUser message: ' + stdinContent);
    } else {
      proc.stdin.write(stdinContent);
    }
    proc.stdin.end();

    proc.stdout.on('data', (chunk) => process.stdout.write(chunk));

    proc.stderr.on('data', (chunk) => {
      const t = chunk.toString();
      if (/error|fail/i.test(t) && !/⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/u.test(t)) {
        process.stderr.write(chunk);
      }
    });

    proc.on('error', rej);
    proc.on('exit', (code) => res(code ?? 0));
  });
}

// ── TUI ──────────────────────────────────────────────────────────────────────
class KeenCLI {
  constructor({ workdir, systemPrompt }) {
    this.workdir = workdir;
    this.systemPrompt = systemPrompt;
    this.isFirst = true;
    this.busy = false;
    this.input = '';
    this.cursor = 0;
    this.history = [];
    this.histIdx = -1;
    this.savedInput = '';
  }

  get rows() { return process.stdout.rows || 24; }
  get cols() { return process.stdout.columns || 80; }
  // Scroll region occupies rows 1 … (rows - 3). Bottom 3 rows are fixed:
  //   rows-2 = separator,  rows-1 = input,  rows = tips
  get scrollEnd() { return Math.max(this.rows - 3, 4); }

  w(s) { process.stdout.write(s); }
  rule() { return a.dim('─'.repeat(this.cols)); }

  // ── Layout ───────────────────────────────────────────────────────────────
  setup() {
    this.w(a.clear);
    this.w(a.scrollRgn(1, this.scrollEnd));

    // Header (inside scroll region)
    this.w(a.moveTo(1, 1));
    this.w('╔══════════════════════╗\n');
    this.w('║       Keen CLI       ║\n');
    this.w('╚══════════════════════╝\n');
    this.w(a.dim(`workdir ${this.workdir}\n`));
    this.w('\n');

    // Save cursor position in scroll region (for later restore)
    this.w(a.save);

    this.drawBottom();

    // Resize handler
    process.stdout.on('resize', () => {
      this.w(a.scrollRgn(1, this.scrollEnd));
      this.drawBottom();
    });

    // Raw keyboard mode
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on('data', (d) => this.onKey(d));
  }

  cleanup() {
    this.w(a.resetScroll);
    this.w(a.show);
    this.w(a.moveTo(this.rows, 1) + '\n');
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  }

  drawBottom() {
    const r = this.rows;
    // Separator
    this.w(a.moveTo(r - 2, 1) + a.clearLine + this.rule());
    // Input line
    this.w(a.moveTo(r - 1, 1) + a.clearToEnd);
    this.w(`${a.bold('>')} ${this.input}`);
    // Tips line
    this.w(a.moveTo(r, 1) + a.clearToEnd);
    if (this.busy) {
      this.w(`  ${a.dim('⏳ thinking...')}`);
    } else {
      this.w([
        `  ${a.cyan('↵ send')}`,
        `${a.yellow('^C exit')}`,
        `${a.green('^L clear')}`,
        `${a.magenta('↑↓ history')}`,
        `${a.gray('^U clear line')}`,
      ].join('  '));
    }
    // Park cursor on input line at the right column
    this.w(a.moveTo(r - 1, 3 + this.cursor));
  }

  // ── Submit ─────────────────────────────────────────────────────────────
  async submit() {
    const text = this.input.trim();
    if (!text || this.busy) return;

    this.history.push(text);
    this.histIdx = this.history.length;
    this.input = '';
    this.cursor = 0;
    this.busy = true;
    this.drawBottom();

    // Restore cursor into scroll region, write user message
    this.w(a.restore);
    this.w(`\n${a.bold('>')} ${text}\n\n`);

    try {
      const code = await runTurn(text, {
        workdir: this.workdir,
        isFirst: this.isFirst,
        systemPrompt: this.systemPrompt
      });
      this.isFirst = false;
      if (code !== 0) this.w(a.dim(`\n[keen] exit code ${code}\n`));
    } catch (err) {
      this.w(a.dim(`\n[keen] error: ${err.message}\n`));
    }

    this.w('\n');
    this.w(a.save); // save position in scroll region for next round
    this.busy = false;
    this.drawBottom();
  }

  // ── Keyboard ───────────────────────────────────────────────────────────
  onKey(data) {
    // Always allow Ctrl+C
    if (data.toString() === '\x03') {
      this.cleanup();
      console.log(a.dim('[keen] Goodbye.'));
      process.exit(0);
    }

    if (this.busy) return; // ignore everything else while thinking

    const key = data.toString();
    const hex = data.toString('hex');

    // Enter
    if (key === '\r' || key === '\n') { this.submit(); return; }

    // Backspace (0x7f Unix, 0x08 Windows)
    if (key === '\x7f' || hex === '08') {
      if (this.cursor > 0) {
        this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor);
        this.cursor--;
        this.drawBottom();
      }
      return;
    }

    // Ctrl+L — clear scroll region
    if (key === '\x0c') {
      this.w(a.clear);
      this.w(a.scrollRgn(1, this.scrollEnd));
      this.w(a.moveTo(1, 1));
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
      return; // ignore other sequences
    }

    // Printable characters
    if (key.length >= 1 && key.charCodeAt(0) >= 32) {
      this.input = this.input.slice(0, this.cursor) + key + this.input.slice(this.cursor);
      this.cursor += key.length;
      this.drawBottom();
    }
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
  process.on('exit', () => cli.cleanup());
  process.on('uncaughtException', (err) => {
    cli.cleanup();
    console.error('[keen] Fatal:', err.message);
    process.exit(1);
  });
  cli.setup();
}
