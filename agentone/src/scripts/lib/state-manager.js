import fs from 'node:fs';
import path from 'node:path';

function nowIso() {
  return new Date().toISOString();
}

function serializeError(error) {
  if (!error) return null;
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  if (typeof error === 'string') {
    return { message: error };
  }
  return error;
}

function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export class PipelineState {
  constructor(runId, opts = {}) {
    if (!runId || typeof runId !== 'string') {
      throw new Error('PipelineState constructor requires a non-empty runId string.');
    }

    this.runId = runId;
    this.runDir = path.join('logs', 'pipeline-runs', runId);
    this.runDirAbs = path.resolve(this.runDir);
    this.runJsonPath = path.join(this.runDirAbs, 'run.json');

    fs.mkdirSync(this.runDirAbs, { recursive: true });

    const existing = readJsonIfExists(this.runJsonPath);
    if (existing) {
      this.state = existing;
    } else {
      this.state = {
        runId,
        profile: opts.profile || null,
        status: 'running',
        currentStage: null,
        stages: {},
        pause: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      this.#persistRun();
    }
  }

  stageStart(stageName) {
    if (!stageName || typeof stageName !== 'string') {
      throw new Error('stageStart(stageName) requires a non-empty stageName string.');
    }
    this.state.currentStage = stageName;
    this.state.stages[stageName] = {
      ...(this.state.stages[stageName] || {}),
      status: 'running',
      startedAt: nowIso(),
    };
    this.state.updatedAt = nowIso();
    this.#persistRun();
  }

  checkpoint(stageName, output) {
    if (!stageName || typeof stageName !== 'string') {
      throw new Error('checkpoint(stageName, output) requires a non-empty stageName string.');
    }

    const artifactPath = path.join(this.runDirAbs, `${stageName}.json`);
    writeJsonAtomic(artifactPath, output);

    this.state.currentStage = stageName;
    this.state.stages[stageName] = {
      ...(this.state.stages[stageName] || {}),
      status: 'completed',
      artifact: `${stageName}.json`,
      completedAt: nowIso(),
    };

    if (stageName === 'completed') {
      this.state.status = 'completed';
      this.state.completedAt = nowIso();
    } else if (this.state.status === 'PAUSED_HITL') {
      this.state.status = 'running';
    }

    this.state.updatedAt = nowIso();
    this.#persistRun();
  }

  isCompleted(stageName) {
    return this.state.stages?.[stageName]?.status === 'completed';
  }

  getStageOutput(stageName) {
    const stage = this.state.stages?.[stageName];
    if (!stage || stage.status !== 'completed') {
      return undefined;
    }

    if (Object.prototype.hasOwnProperty.call(stage, 'output')) {
      return stage.output;
    }

    const artifactPath = path.join(this.runDirAbs, `${stageName}.json`);
    if (!fs.existsSync(artifactPath)) {
      return undefined;
    }

    return readJsonIfExists(artifactPath);
  }

  setProfile(profileName) {
    this.state.profile = profileName;
    this.state.updatedAt = nowIso();
    this.#persistRun();
  }

  pause(reason, data = null) {
    this.state.status = 'PAUSED_HITL';
    this.state.pause = {
      reason: reason || null,
      data,
      pausedAt: nowIso(),
    };
    this.state.updatedAt = nowIso();
    this.#persistRun();
  }

  resume(decision) {
    const pauseData = this.state.pause || null;

    this.state.status = 'running';
    this.state.pause = {
      ...(pauseData || {}),
      decision: decision ?? null,
      resumedAt: nowIso(),
    };
    this.state.updatedAt = nowIso();
    this.#persistRun();
  }

  fail(stageName, error) {
    const atStage = stageName || this.state.currentStage || null;

    if (atStage) {
      this.state.stages[atStage] = {
        ...(this.state.stages[atStage] || {}),
        status: 'failed',
        error: serializeError(error),
        failedAt: nowIso(),
      };
      this.state.currentStage = atStage;
    }

    this.state.status = 'failed';
    this.state.failedAt = nowIso();
    this.state.updatedAt = nowIso();
    this.#persistRun();
  }

  getRunDir() {
    return this.runDir;
  }

  toJSON() {
    return {
      ...this.state,
    };
  }

  #persistRun() {
    writeJsonAtomic(this.runJsonPath, this.state);
  }
}