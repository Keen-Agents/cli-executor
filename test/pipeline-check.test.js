import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CHECK_FILE = resolve(__dirname, 'pipeline-check.txt');
const TICKET_KEY = 'TASK-1773345932487';

// Helper: run git commands from the repo root
function git(cmd) {
  return execSync(`git ${cmd}`, { cwd: ROOT, encoding: 'utf-8' }).trim();
}

// Normalize CRLF → LF for cross-platform consistency
function normalizeLF(str) {
  return str.replace(/\r\n/g, '\n');
}

// ---------------------------------------------------------------------------
// Unit Tests — validate the artifact's content structure
// ---------------------------------------------------------------------------
describe('Unit: pipeline-check.txt content format', () => {
  let content;
  let lines;

  it('file is readable and non-empty', () => {
    content = normalizeLF(readFileSync(CHECK_FILE, 'utf-8'));
    assert.ok(content.length > 0, 'File should not be empty');
    lines = content.split('\n').filter((l) => l.length > 0);
  });

  it('first line is the smoke-test pass confirmation', () => {
    content ??= normalizeLF(readFileSync(CHECK_FILE, 'utf-8'));
    lines ??= content.split('\n').filter((l) => l.length > 0);
    assert.match(lines[0], /^Pipeline smoke-test passed\.$/);
  });

  it('contains a Ticket line with the correct ticket key', () => {
    content ??= normalizeLF(readFileSync(CHECK_FILE, 'utf-8'));
    lines ??= content.split('\n').filter((l) => l.length > 0);
    const ticketLine = lines.find((l) => l.startsWith('Ticket:'));
    assert.ok(ticketLine, 'Should have a Ticket line');
    assert.ok(
      ticketLine.includes(TICKET_KEY),
      `Ticket line should reference ${TICKET_KEY}`,
    );
  });

  it('contains a Timestamp line with a valid ISO 8601 date', () => {
    content ??= normalizeLF(readFileSync(CHECK_FILE, 'utf-8'));
    lines ??= content.split('\n').filter((l) => l.length > 0);
    const tsLine = lines.find((l) => l.startsWith('Timestamp:'));
    assert.ok(tsLine, 'Should have a Timestamp line');

    const tsValue = tsLine.replace('Timestamp:', '').trim();
    const parsed = new Date(tsValue);
    assert.ok(!isNaN(parsed.getTime()), 'Timestamp should be a valid date');
    assert.match(tsValue, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('timestamp is not in the future', () => {
    content ??= normalizeLF(readFileSync(CHECK_FILE, 'utf-8'));
    const tsLine = content
      .split('\n')
      .find((l) => l.startsWith('Timestamp:'));
    const tsValue = tsLine.replace('Timestamp:', '').trim();
    const ts = new Date(tsValue);
    assert.ok(ts <= new Date(), 'Timestamp should not be in the future');
  });
});

// ---------------------------------------------------------------------------
// Integration Tests — file system + git integration
// ---------------------------------------------------------------------------
describe('Integration: pipeline artifact on disk', () => {
  it('test/pipeline-check.txt exists', () => {
    assert.ok(existsSync(CHECK_FILE), 'pipeline-check.txt should exist');
  });

  it('file is a regular file (not a directory or symlink)', () => {
    const stat = statSync(CHECK_FILE);
    assert.ok(stat.isFile(), 'Should be a regular file');
  });

  it('file size is reasonable (between 10 and 500 bytes)', () => {
    const stat = statSync(CHECK_FILE);
    assert.ok(stat.size >= 10, 'File should be at least 10 bytes');
    assert.ok(stat.size <= 500, 'File should be under 500 bytes');
  });
});

describe('Integration: git commit for pipeline-check.txt', () => {
  it('pipeline-check.txt is tracked by git', () => {
    const tracked = git('ls-files test/pipeline-check.txt');
    assert.equal(tracked, 'test/pipeline-check.txt');
  });

  it('there is a commit that added test/pipeline-check.txt', () => {
    const log = git('log --oneline --diff-filter=A -- test/pipeline-check.txt');
    assert.ok(log.length > 0, 'Should have a commit that added the file');
  });

  it('the commit message references the ticket key', () => {
    const msg = git(
      'log -1 --format=%s --diff-filter=A -- test/pipeline-check.txt',
    );
    assert.ok(
      msg.includes(TICKET_KEY),
      `Commit message should reference ${TICKET_KEY}, got: "${msg}"`,
    );
  });

  it('working tree is clean (no uncommitted changes to the file)', () => {
    const diff = git('diff -- test/pipeline-check.txt');
    assert.equal(diff, '', 'There should be no unstaged changes');

    const diffCached = git('diff --cached -- test/pipeline-check.txt');
    assert.equal(diffCached, '', 'There should be no staged changes');
  });
});

// ---------------------------------------------------------------------------
// End-to-End Tests — full pipeline output verification
// ---------------------------------------------------------------------------
describe('E2E: pipeline execution verification', () => {
  it('current branch follows the pipeline naming convention', () => {
    const branch = git('branch --show-current');
    assert.match(
      branch,
      /^pipeline\//,
      'Branch should start with pipeline/',
    );
    assert.ok(
      branch.includes(TICKET_KEY),
      `Branch name should include ${TICKET_KEY}`,
    );
  });

  it('the pipeline commit is the HEAD of the branch', () => {
    const headMsg = git('log -1 --format=%s');
    assert.ok(
      headMsg.includes(TICKET_KEY),
      `HEAD commit should reference ${TICKET_KEY}`,
    );
    assert.ok(
      headMsg.toLowerCase().includes('pipeline'),
      'HEAD commit message should mention pipeline',
    );
  });

  it('the file content, commit, and branch are all consistent', () => {
    // Read file content from git (committed version) — normalize line endings
    const gitContent = normalizeLF(git('show HEAD:test/pipeline-check.txt'));
    const diskContent = normalizeLF(readFileSync(CHECK_FILE, 'utf-8')).trimEnd();

    assert.equal(
      gitContent,
      diskContent,
      'Git content and disk content should match',
    );
  });

  it('the commit is reachable from the current branch', () => {
    const sha = git(
      'log -1 --format=%H --diff-filter=A -- test/pipeline-check.txt',
    );
    const branch = git('branch --show-current');
    const contains = git(`branch --contains ${sha}`);
    assert.ok(
      contains.includes(branch.split('/').pop()),
      'Pipeline commit should be on the current branch',
    );
  });
});
