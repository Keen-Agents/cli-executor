// @ts-check

import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, basename, join } from 'path';

export const EVENT_TYPES = Object.freeze([
  'STAGE_STARTED',
  'STAGE_COMPLETED',
  'STAGE_FAILED',
  'SESSION_SPAWNED',
  'SESSION_COMPLETED',
  'GATE_CHECK',
  'PAUSED_HITL',
  'RESUMED',
  'COST_UPDATE',
  'BUDGET_WARNING',
  'BUDGET_EXCEEDED'
]);

const EVENT_TYPE_SET = new Set(EVENT_TYPES);

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g,
  /b3d6d5c1[a-f0-9]+/gi,
  /Bearer\s+[A-Za-z0-9._~+\/-]+=*/g,
  /-----BEGIN[^-]+-----[\s\S]*?-----END[^-]+-----/g,
  /(api[_-]?key|token|password|secret|authorization)[:=]\s*["']?[^\s"']+/gi
];

/**
 * Recursively redacts secret-like values from strings, arrays, and objects.
 * @param {unknown} value
 * @returns {unknown}
 */
function redactSecrets(value) {
  if (typeof value === 'string') {
    let redacted = value;
    for (const pattern of SECRET_PATTERNS) {
      redacted = redacted.replace(pattern, '[REDACTED]');
    }
    return redacted;
  }

  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }

  if (value && typeof value === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (value);
    const out = {};
    for (const [key, val] of Object.entries(obj)) {
      out[key] = redactSecrets(val);
    }
    return out;
  }

  return value;
}

export class PipelineLogger {
  /**
   * @param {string} eventsFilePath
   * @param {string} [runId]
   */
  constructor(eventsFilePath, runId) {
    this.eventsFilePath = eventsFilePath;
    this.runId = runId || basename(dirname(eventsFilePath));

    mkdirSync(dirname(eventsFilePath), { recursive: true });
    writeFileSync(eventsFilePath, '', { flag: 'a' });
  }

  /**
   * Appends one NDJSON event to the event log.
   * @param {{ type: string, stage?: string, [key: string]: unknown }} event
   */
  log(event) {
    if (!event || typeof event !== 'object') {
      throw new Error('PipelineLogger.log(event) requires an object event payload.');
    }

    if (!EVENT_TYPE_SET.has(event.type)) {
      throw new Error(`Unsupported event type: ${event.type}`);
    }

    const redactedEvent = /** @type {Record<string, unknown>} */ (redactSecrets(event));
    const payload = {
      timestamp: new Date().toISOString(),
      runId: this.runId,
      ...redactedEvent
    };

    appendFileSync(this.eventsFilePath, `${JSON.stringify(payload)}\n`, 'utf8');
  }
}

/**
 * @param {string} runDir
 * @param {string} runId
 * @returns {PipelineLogger}
 */
export function createLogger(runDir, runId) {
  const eventsFilePath = join(runDir, 'logs', 'pipeline-runs', runId, 'events.ndjson');
  return new PipelineLogger(eventsFilePath, runId);
}