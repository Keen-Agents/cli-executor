#!/usr/bin/env node
// @ts-check

/**
 * AgentOne CLI — simple entry point
 *
 * Usage:
 *   ago "Add a login page"                     # prompt mode, uses cwd
 *   ago PROJ-123                               # Jira ticket mode
 *   ago "Fix the bug" --workdir /path/to/repo  # explicit workdir
 *   ago --file tasks/my-task.md                 # prompt from file
 *   ago PROJ-123 --profile complex             # force profile
 *   ago --resume <run-id>                       # resume a paused run
 */

import { pathToFileURL } from 'node:url';
import path from 'node:path';

const JIRA_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

function printHelp() {
  console.log(`
  AgentOne CLI

  Usage:
    ago <prompt>                     Run a task from a text prompt
    ago <TICKET-KEY>                 Run a Jira ticket (e.g. PROJ-123)
    ago --file <path>               Run a task from a prompt file
    ago --resume <run-id>           Resume a paused run

  Options:
    --workdir <path>      Working directory (default: current dir)
    --profile <name>      Force profile: simple, standard, complex
    --run-id <id>         Custom run ID
    --file <path>         Read prompt from a file
    --resume <run-id>     Resume a previous run
    -h, --help            Show this help
`);
}

function parseCliArgs(argv) {
  const opts = {
    ticketKey: '',
    prompt: '',
    promptFile: '',
    workingDirectory: process.cwd(),
    profile: '',
    runId: '',
    resume: false,
  };

  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    }

    if (arg === '--workdir' || arg === '-w') {
      opts.workingDirectory = path.resolve(argv[++i] || '');
      continue;
    }

    if (arg === '--profile' || arg === '-p') {
      opts.profile = argv[++i] || '';
      continue;
    }

    if (arg === '--run-id') {
      opts.runId = argv[++i] || '';
      continue;
    }

    if (arg === '--file' || arg === '-f') {
      opts.promptFile = path.resolve(argv[++i] || '');
      continue;
    }

    if (arg === '--resume' || arg === '-r') {
      opts.resume = true;
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        opts.runId = next;
        i++;
      }
      continue;
    }

    positional.push(arg);
  }

  // First positional arg: either a Jira key or a prompt
  if (positional.length > 0) {
    const first = positional.join(' ');
    if (JIRA_KEY_RE.test(positional[0])) {
      opts.ticketKey = positional[0];
      // Remaining positional words are ignored for Jira mode
    } else {
      opts.prompt = first;
    }
  }

  return opts;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));

  if (!args.ticketKey && !args.prompt && !args.promptFile && !args.resume) {
    printHelp();
    process.exit(1);
  }

  // Dynamic import so pipeline.js doesn't run its own main()
  const { exec } = await import('./src/scripts/pipeline.js');

  await exec({
    ticketKey: args.ticketKey,
    prompt: args.prompt,
    promptFile: args.promptFile,
    workingDirectory: args.workingDirectory,
    profile: args.profile,
    runId: args.runId,
    resume: args.resume,
  });
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
