#!/usr/bin/env node
/**
 * approve.js — CLI tool to approve/revise/reject a pipeline human-gate.
 *
 * Usage:
 *   node approve.js --run-id <id> [--decision approve|revise|reject] [--comments "..."] [--gate human-gate:2]
 *
 * If --decision is omitted, defaults to "approve".
 * If --gate is omitted, looks for any pending human-decision-request*.json in the run dir.
 */
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = { runId: '', decision: 'approve', comments: '', gate: '' };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--run-id') { args.runId = argv[++i] || ''; continue; }
    if (arg === '--decision') { args.decision = argv[++i] || ''; continue; }
    if (arg === '--comments') { args.comments = argv[++i] || ''; continue; }
    if (arg === '--gate') { args.gate = argv[++i] || ''; continue; }
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node approve.js --run-id <id> [--decision approve|revise|reject] [--comments "..."] [--gate human-gate:2]');
      process.exit(0);
    }
  }

  if (!args.runId) {
    console.error('Error: --run-id is required');
    process.exit(1);
  }

  const valid = new Set(['approve', 'revise', 'reject']);
  if (!valid.has(args.decision)) {
    console.error(`Error: --decision must be approve, revise, or reject (got "${args.decision}")`);
    process.exit(1);
  }

  return args;
}

function findPendingRequest(runDir, gate) {
  if (gate) {
    const suffix = gate !== 'human-gate' ? `-${gate.replace(':', '-')}` : '';
    const requestFile = suffix ? `human-decision-request${suffix}.json` : 'human-decision-request.json';
    const decisionFile = suffix ? `human-decision${suffix}.json` : 'human-decision.json';
    const requestPath = path.join(runDir, requestFile);
    const decisionPath = path.join(runDir, decisionFile);

    if (!fs.existsSync(requestPath)) {
      return null;
    }
    if (fs.existsSync(decisionPath)) {
      return null; // Already decided
    }
    return { requestFile, decisionFile, decisionPath };
  }

  // Auto-detect: find any request file without a corresponding decision file
  const files = fs.readdirSync(runDir).filter(f => f.startsWith('human-decision-request'));
  for (const reqFile of files) {
    const decFile = reqFile.replace('request', '').replace('--', '-');
    // human-decision-request.json → human-decision.json
    // human-decision-request-human-gate-2.json → human-decision-human-gate-2.json
    const decisionFile = reqFile.replace('-request', '');
    const decisionPath = path.join(runDir, decisionFile);
    if (!fs.existsSync(decisionPath)) {
      return { requestFile: reqFile, decisionFile, decisionPath };
    }
  }

  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDir = path.resolve('logs', 'pipeline-runs', args.runId);

  if (!fs.existsSync(runDir)) {
    console.error(`Error: Run directory not found: ${runDir}`);
    process.exit(1);
  }

  const pending = findPendingRequest(runDir, args.gate);
  if (!pending) {
    console.error('Error: No pending human-gate decision found for this run.');
    if (args.gate) {
      console.error(`  Looked for gate: ${args.gate}`);
    }
    console.error(`  Run dir: ${runDir}`);
    process.exit(1);
  }

  const payload = {
    decision: args.decision,
    comments: args.comments || null,
    decidedAt: new Date().toISOString(),
    source: 'approve-cli'
  };

  fs.writeFileSync(pending.decisionPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`Decision "${args.decision}" written to ${pending.decisionFile}`);
  if (args.comments) {
    console.log(`Comments: ${args.comments}`);
  }
}

main();
