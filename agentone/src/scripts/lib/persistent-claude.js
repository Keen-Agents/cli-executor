/**
 * Persistent Claude CLI process — keeps a long-lived `claude -p` process
 * running with stream-json pipes to avoid cold-start overhead per turn.
 *
 * First turn: ~3s (process startup).  Subsequent turns: ~1s (just network).
 *
 * Protocol:
 *   stdin  (NDJSON):  {"type":"user","content":[{"type":"text","text":"..."}]}
 *   stdout (NDJSON):  {"type":"assistant",...} / {"type":"result",...}
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export class PersistentClaude {
  constructor({ workdir, systemPrompt, model }) {
    this.workdir = workdir;
    this.systemPrompt = systemPrompt;
    this.model = model || 'claude-sonnet-4-5-20250514';
    this._proc = null;
    this._alive = false;
    this._buffer = '';           // partial line buffer for stdout
    this._turnResolve = null;    // resolve fn for current turn
    this._turnReject = null;
    this._turnOutput = '';       // accumulated text for current turn
    this._onData = null;         // streaming callback
    this._promptFile = null;
    this._sessionId = `keen-persistent-${randomUUID().slice(0, 8)}`;
  }

  /** Spawn the persistent process. Resolves when process is ready. */
  async start() {
    if (this._alive) return;

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];

    // System prompt via temp file
    if (this.systemPrompt) {
      const tmpDir = mkdtempSync(join(tmpdir(), 'keen-pc-'));
      this._promptFile = join(tmpDir, 'system-prompt.txt');
      writeFileSync(this._promptFile, this.systemPrompt, 'utf8');
      args.push('--append-system-prompt-file', this._promptFile);
    }

    this._proc = spawn('claude', args, {
      cwd: this.workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: { ...process.env }
    });

    this._alive = true;
    this._buffer = '';

    this._proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this._proc.stderr.on('data', () => {}); // ignore stderr
    this._proc.on('error', (err) => {
      this._alive = false;
      if (this._turnReject) this._turnReject(err);
    });
    this._proc.on('exit', () => {
      this._alive = false;
      if (this._turnReject) {
        this._turnReject(new Error('Claude process exited unexpectedly'));
      }
    });
    this._proc.stdin.on('error', () => {}); // ignore EPIPE

    // Wait briefly for process to initialize
    await new Promise(r => setTimeout(r, 200));
  }

  /** Send a user message and stream the response. Returns full output. */
  async sendMessage(text, { onData, timeout = 120_000 } = {}) {
    if (!this._alive) await this.start();

    this._turnOutput = '';
    this._onData = onData || null;

    const message = JSON.stringify({
      type: 'user',
      content: [{ type: 'text', text }]
    }) + '\n';

    return new Promise((resolve, reject) => {
      this._turnResolve = resolve;
      this._turnReject = reject;

      // Timeout guard
      const timer = setTimeout(() => {
        this._turnResolve = null;
        this._turnReject = null;
        reject(new Error(`Turn timed out after ${timeout / 1000}s`));
      }, timeout);

      // Wrap resolve to clear timer
      const origResolve = resolve;
      this._turnResolve = (val) => {
        clearTimeout(timer);
        origResolve(val);
      };
      const origReject = reject;
      this._turnReject = (err) => {
        clearTimeout(timer);
        origReject(err);
      };

      try {
        this._proc.stdin.write(message);
      } catch (err) {
        clearTimeout(timer);
        this._turnResolve = null;
        this._turnReject = null;
        reject(err);
      }
    });
  }

  /** Parse NDJSON stdout chunks. */
  _onStdout(chunk) {
    this._buffer += chunk.toString();

    // Process complete lines
    let nlIdx;
    while ((nlIdx = this._buffer.indexOf('\n')) !== -1) {
      const line = this._buffer.slice(0, nlIdx).trim();
      this._buffer = this._buffer.slice(nlIdx + 1);
      if (!line) continue;

      try {
        const event = JSON.parse(line);
        this._handleEvent(event);
      } catch {
        // Not JSON — ignore
      }
    }
  }

  /** Handle a parsed stream-json event. */
  _handleEvent(event) {
    const type = event.type;

    if (type === 'assistant') {
      // Extract text from content blocks
      const blocks = event.message?.content || event.content || [];
      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          this._turnOutput += block.text;
          if (this._onData) this._onData(block.text);
        }
      }
    }

    if (type === 'content_block_delta') {
      // Streaming delta
      const delta = event.delta;
      if (delta?.type === 'text_delta' && delta.text) {
        this._turnOutput += delta.text;
        if (this._onData) this._onData(delta.text);
      }
    }

    if (type === 'result') {
      // Turn complete
      if (this._turnResolve) {
        const resolve = this._turnResolve;
        this._turnResolve = null;
        this._turnReject = null;
        this._onData = null;
        resolve({ code: 0, output: this._turnOutput });
      }
    }
  }

  /** Check if the persistent process is still running. */
  isAlive() {
    return this._alive;
  }

  /** Kill the persistent process. */
  destroy() {
    this._alive = false;
    this._turnResolve = null;
    this._turnReject = null;
    this._onData = null;
    if (this._proc) {
      try { this._proc.stdin.end(); } catch {}
      try { this._proc.kill(); } catch {}
      this._proc = null;
    }
    if (this._promptFile) {
      try { unlinkSync(this._promptFile); } catch {}
    }
  }
}
