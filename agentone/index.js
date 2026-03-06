import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCli } from './src/scripts/pipeline.js';

export { exec, parseArgs, runCli, runPipeline } from './src/scripts/pipeline.js';

function isDirectExecution() {
  if (!process.argv[1]) {
    return false;
  }

  const modulePath = fileURLToPath(import.meta.url);
  const moduleDir = path.dirname(modulePath);
  const entryPath = path.resolve(process.argv[1]);

  if (entryPath === modulePath) {
    return true;
  }

  try {
    return fs.statSync(entryPath).isDirectory() && entryPath === moduleDir;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  runCli().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Pipeline fatal error:', message);
    process.exit(1);
  });
}
