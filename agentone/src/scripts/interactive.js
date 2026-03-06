#!/usr/bin/env node
/**
 * Keen CLI — conversational REPL powered by Claude/Codex as orchestrator.
 *
 * Usage:  node src/scripts/interactive.js [--workdir <dir>]
 *         npm run agent
 *
 * Features:
 *   /model claude|codex   — switch primary dispatcher
 *   /model                — toggle between Claude and Codex
 *   /thinking             — toggle secondary model output view
 *   Ctrl+T                — same as /thinking
 *
 * Both models run on every prompt: primary streams to screen,
 * secondary runs in background via bridge. Ctrl+T toggles view.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SYSTEM_PROMPT_PATH = resolve(__dirname, 'prompts/orchestrator.md');

// Ensure bridge API token is available for agent-runner.js (secondary model dispatch).
// The bridge hardcodes this token; pipeline-config.js reads from env vars.
if (!process.env.AGENTONE_API_TOKEN && !process.env.BRIDGE_API_TOKEN) {
  process.env.BRIDGE_API_TOKEN = 'b3d6d5c1a50155e207c503102f7bc610';
}

// ── Slash command registry ───────────────────────────────────────────────────
const SLASH_COMMANDS = [
  { cmd: '/model',    args: '[claude|codex]', desc: 'Switch or toggle primary model' },
  { cmd: '/thinking', args: '',               desc: 'Toggle secondary model output (Ctrl+T)' },
  { cmd: '/clear',    args: '',               desc: 'Clear screen (Ctrl+L)' },
  { cmd: '/help',     args: '',               desc: 'Show available commands' },
];

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
  red:         s => `${CSI}31m${s}${CSI}0m`,
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

// ── Run a single orchestrator turn ──────────────────────────────────────────
function runTurn(stdinContent, { workdir, isFirst, systemPrompt, model, conversationHistory, onData }) {
  if (model === 'codex') {
    return runCodexTurn(stdinContent, { workdir, systemPrompt, conversationHistory, onData });
  }
  return runClaudeTurn(stdinContent, { workdir, isFirst, systemPrompt, onData });
}

function runClaudeTurn(stdinContent, { workdir, isFirst, systemPrompt, onData }) {
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

    if (isFirst) {
      proc.stdin.write(systemPrompt + '\n\n---\n\nUser message: ' + stdinContent);
    } else {
      proc.stdin.write(stdinContent);
    }
    proc.stdin.end();

    let fullOutput = '';
    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      fullOutput += text;
      if (onData) onData(text);
      else process.stdout.write(chunk);
    });

    proc.stderr.on('data', (chunk) => {
      const t = chunk.toString();
      if (/error|fail/i.test(t) && !/⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/u.test(t)) {
        process.stderr.write(chunk);
      }
    });

    proc.on('error', rej);
    proc.on('exit', (code) => res({ code: code ?? 0, output: fullOutput }));
  });
}

function runCodexTurn(stdinContent, { workdir, systemPrompt, conversationHistory, onData }) {
  return new Promise((res, rej) => {
    // Build full prompt with conversation history (Codex has no --continue)
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

    // Use '-' to read prompt from stdin (avoids Windows 8191-char cmd line limit).
    // No --full-auto (doesn't exist); codex exec runs non-interactively by default.
    const args = ['exec', '-'];

    const proc = spawn('codex', args, {
      cwd: workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      env: { ...process.env }
    });

    proc.stdin.write(fullPrompt);
    proc.stdin.end();

    let fullOutput = '';
    let stderrOutput = '';

    // Codex puts the final answer on stdout and thinking/progress on stderr.
    // Capture both — stdout is the primary response, stderr has the context.
    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      fullOutput += text;
      if (onData) onData(text);
      else process.stdout.write(chunk);
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrOutput += text;
      // Also stream stderr to onData so the thinking panel shows codex's progress
      if (onData) onData(text);
    });

    proc.on('error', rej);
    proc.on('exit', (code) => {
      // Combine: stderr (thinking/progress) + stdout (final answer)
      const combined = stderrOutput + (fullOutput ? '\n' + fullOutput : '');
      res({ code: code ?? 0, output: combined });
    });
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

    // ── Dual-model state ─────────────────────────────────────────
    this.primaryModel = 'claude';
    this.secondaryModel = 'codex';
    this.conversationHistory = [];

    // Per-turn output buffers
    this.primaryOutput = '';
    this.secondaryOutput = '';
    this.secondaryStatus = 'idle';  // 'idle' | 'running' | 'done' | 'error'
    this.secondaryError = null;

    // Toggle state
    this.showingSecondary = false;
  }

  get rows() { return process.stdout.rows || 24; }
  get cols() { return process.stdout.columns || 80; }
  get scrollEnd() { return Math.max(this.rows - 3, 4); }

  w(s) { process.stdout.write(s); }
  rule() { return a.dim('\u2500'.repeat(this.cols)); }

  // ── Layout ───────────────────────────────────────────────────────────────
  setup() {
    this.w(a.clear);
    this.w(a.scrollRgn(1, this.scrollEnd));

    this.w(a.moveTo(1, 1));
    this.w('\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557\n');
    this.w('\u2551       Keen CLI       \u2551\n');
    this.w('\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D\n');
    this.w(a.dim(`workdir ${this.workdir}\n`));
    const modelColor = this.primaryModel === 'claude' ? a.cyan : a.yellow;
    this.w(a.dim('model   ') + modelColor(this.primaryModel) + a.dim(` (secondary: ${this.secondaryModel})`) + '\n');
    this.w('\n');

    this.w(a.save);
    this.drawBottom();

    process.stdout.on('resize', () => {
      this.w(a.scrollRgn(1, this.scrollEnd));
      this.drawBottom();
    });

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

    // Input line with model badge
    this.w(a.moveTo(r - 1, 1) + a.clearToEnd);
    const badge = this.primaryModel === 'claude'
      ? a.cyan(`[claude]`)
      : a.yellow(`[codex]`);
    this.w(`${badge} ${a.bold('>')} ${this.input}`);

    // Tips line
    this.w(a.moveTo(r, 1) + a.clearToEnd);
    if (this.busy) {
      const panelLabel = this.showingSecondary
        ? a.yellow(`viewing: ${this.secondaryModel}`)
        : a.cyan(`viewing: ${this.primaryModel}`);
      const secStatus = this.secondaryStatusLabel();
      const modelColor = this.primaryModel === 'claude' ? a.cyan : a.yellow;
      this.w(`  ${modelColor('\u23F3 ' + this.primaryModel + ' thinking...')}  ${panelLabel}  ${secStatus}`);
    } else {
      // Show slash command suggestions when typing /
      const suggestions = this.slashSuggestions();
      if (suggestions) {
        this.w(`  ${suggestions}  ${a.dim('Tab to complete')}`);
      } else {
        const secStatus = this.secondaryStatusLabel();
        const tips = [
          `  ${a.cyan('\u21B5 send')}`,
          `${a.yellow('^C exit')}`,
          `${a.green('^L clear')}`,
          `${a.magenta('\u2191\u2193 history')}`,
          `${a.gray('^T thinking')}`,
        ];
        if (secStatus) tips.push(secStatus);
        this.w(tips.join('  '));
      }
    }

    // Park cursor on input line (adjust for badge width)
    const badgeLen = this.primaryModel.length + 2; // "[claude]" or "[codex]"
    this.w(a.moveTo(r - 1, badgeLen + 4 + this.cursor)); // badge + " > " + cursor
  }

  secondaryStatusLabel() {
    const model = this.secondaryModel;
    switch (this.secondaryStatus) {
      case 'running': return a.dim(`${model}: running...`);
      case 'done':    return a.green(`${model}: done`) + a.dim(' (^T to view)');
      case 'error':   return a.red(`${model}: ${this.secondaryError || 'error'}`);
      default:        return '';
    }
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
        this.writeToScroll(a.yellow(`Unknown model: ${arg}. Use /model claude or /model codex\n`));
        this.w(a.save);
      }
      return true;
    }

    if (cmd === '/thinking') {
      this.toggleSecondaryView();
      return true;
    }

    if (cmd === '/clear') {
      this.w(a.clear);
      this.w(a.scrollRgn(1, this.scrollEnd));
      this.w(a.moveTo(1, 1));
      this.w(a.save);
      return true;
    }

    if (cmd === '/help') {
      this.writeToScroll('\n' + a.bold('Available commands:\n'));
      for (const { cmd: c, args: ar, desc } of SLASH_COMMANDS) {
        const full = ar ? `${c} ${ar}` : c;
        this.writeToScroll(`  ${a.cyan(full.padEnd(24))} ${a.dim(desc)}\n`);
      }
      this.writeToScroll('\n' + a.bold('Keyboard shortcuts:\n'));
      this.writeToScroll(`  ${a.cyan('Ctrl+T'.padEnd(24))} ${a.dim('Toggle secondary model output')}\n`);
      this.writeToScroll(`  ${a.cyan('Ctrl+L'.padEnd(24))} ${a.dim('Clear screen')}\n`);
      this.writeToScroll(`  ${a.cyan('Ctrl+C'.padEnd(24))} ${a.dim('Exit')}\n`);
      this.writeToScroll(`  ${a.cyan('Ctrl+U'.padEnd(24))} ${a.dim('Clear input line')}\n`);
      this.writeToScroll(`  ${a.cyan('Ctrl+W'.padEnd(24))} ${a.dim('Delete word backward')}\n`);
      this.writeToScroll(`  ${a.cyan('\u2191\u2193 arrows'.padEnd(24))} ${a.dim('History navigation')}\n`);
      this.writeToScroll('\n');
      this.w(a.save);
      return true;
    }

    return false;
  }

  // ── Slash command suggestions ─────────────────────────────────────────
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
    this.secondaryModel = model === 'claude' ? 'codex' : 'claude';
    this.isFirst = true;
    this.conversationHistory = [];

    this.writeToScroll(
      a.green(`\u2714 Primary model: ${a.bold(model)}`) +
      a.dim(` | Secondary: ${this.secondaryModel}\n`)
    );
    this.w(a.save);
    this.drawBottom();
  }

  writeToScroll(text) {
    this.w(a.restore);
    this.w(text);
  }

  // ── Toggle secondary view ─────────────────────────────────────────────
  toggleSecondaryView() {
    this.showingSecondary = !this.showingSecondary;

    this.w(a.clear);
    this.w(a.scrollRgn(1, this.scrollEnd));
    this.w(a.moveTo(1, 1));

    if (this.showingSecondary) {
      const colorFn = this.secondaryModel === 'codex' ? a.yellow : a.cyan;
      this.w(a.dim(`\u2500\u2500 ${this.secondaryModel} (secondary) \u2500\u2500\n\n`));

      if (this.secondaryStatus === 'running') {
        this.w(a.dim('Still running...\n'));
      } else if (this.secondaryOutput) {
        this.w(colorFn(this.secondaryOutput));
      } else {
        this.w(a.dim('No output yet.\n'));
      }
    } else {
      const colorFn = this.primaryModel === 'codex' ? a.yellow : a.cyan;
      this.w(a.dim(`\u2500\u2500 ${this.primaryModel} (primary) \u2500\u2500\n\n`));

      if (this.primaryOutput) {
        this.w(this.primaryOutput);
      } else {
        this.w(a.dim('No output yet.\n'));
      }
    }

    this.w(a.save);
    this.drawBottom();
  }

  // ── Secondary model dispatch (direct child_process, not bridge) ─────
  // Uses direct spawn to avoid Windows cmd.exe 8191-char arg limit.
  async spawnSecondary(userText) {
    this.secondaryStatus = 'running';
    this.secondaryOutput = '';
    this.secondaryError = null;
    this.drawBottom();

    try {
      const result = await runTurn(userText, {
        workdir: this.workdir,
        isFirst: this.isFirst,
        systemPrompt: this.systemPrompt,
        model: this.secondaryModel,
        conversationHistory: this.conversationHistory,
        onData: (chunk) => {
          this.secondaryOutput += chunk;
          // If user is viewing secondary panel, stream it live
          if (this.showingSecondary) {
            process.stdout.write(chunk);
          }
        }
      });

      // Fallback: if streaming didn't capture, use the final combined output
      if (!this.secondaryOutput.trim() && result.output) {
        this.secondaryOutput = result.output;
      }

      this.secondaryStatus = result.code === 0 ? 'done' : 'error';
      if (result.code !== 0) {
        this.secondaryError = `exit ${result.code}`;
      }
    } catch (err) {
      this.secondaryStatus = 'error';
      this.secondaryError = err.message.slice(0, 60);
      this.secondaryOutput = `Error: ${err.message}`;
    }

    this.drawBottom();
  }

  // ── Submit ─────────────────────────────────────────────────────────────
  async submit() {
    const text = this.input.trim();
    if (!text || this.busy) return;

    // Slash commands
    if (text.startsWith('/')) {
      const handled = this.handleSlashCommand(text);
      if (handled) {
        this.input = '';
        this.cursor = 0;
        this.drawBottom();
        return;
      }
    }

    this.history.push(text);
    this.histIdx = this.history.length;
    this.input = '';
    this.cursor = 0;
    this.busy = true;

    // Reset per-turn buffers
    this.primaryOutput = '';
    this.secondaryOutput = '';
    this.secondaryStatus = 'idle';
    this.secondaryError = null;
    this.showingSecondary = false;

    this.drawBottom();

    // Write user message in scroll region
    this.w(a.restore);
    this.w(`\n${a.bold('>')} ${text}\n\n`);

    // 1. Fire-and-forget: spawn secondary model in background
    this.spawnSecondary(text);

    // 2. Run primary model (streams to terminal)
    try {
      const result = await runTurn(text, {
        workdir: this.workdir,
        isFirst: this.isFirst,
        systemPrompt: this.systemPrompt,
        model: this.primaryModel,
        conversationHistory: this.conversationHistory,
        onData: (chunk) => {
          this.primaryOutput += chunk;
          if (!this.showingSecondary) {
            process.stdout.write(chunk);
          }
        }
      });

      this.isFirst = false;

      // Track conversation for Codex context
      this.conversationHistory.push({ role: 'user', content: text });
      this.conversationHistory.push({ role: 'assistant', content: this.primaryOutput });

      // Trim to last 10 turn-pairs
      if (this.conversationHistory.length > 20) {
        this.conversationHistory = this.conversationHistory.slice(-20);
      }

      if (result.code !== 0) this.w(a.dim(`\n[keen] exit code ${result.code}\n`));
    } catch (err) {
      this.w(a.dim(`\n[keen] error: ${err.message}\n`));
    }

    this.w('\n');
    this.w(a.save);
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

    const key = data.toString();

    // Allow Ctrl+T even while busy
    if (key === '\x14') {
      this.toggleSecondaryView();
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
          // Single match — complete it (add trailing space for args)
          this.input = matches[0].cmd + (matches[0].args ? ' ' : '');
          this.cursor = this.input.length;
          this.drawBottom();
        } else if (matches.length > 1) {
          // Multiple matches — complete common prefix
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
      return;
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
