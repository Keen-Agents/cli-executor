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
      this.state = {
        ...existing,
        stages: existing.stages || {},
        sideEffects: Array.isArray(existing.sideEffects) ? existing.sideEffects : [],
        humanRevisions: Array.isArray(existing.humanRevisions) ? existing.humanRevisions : [],
        metadata: existing.metadata && typeof existing.metadata === 'object' ? existing.metadata : {},
        workingDirectory:
          typeof existing.workingDirectory === 'string'
            ? existing.workingDirectory
            : existing?.metadata?.worktreePath || existing?.metadata?.baseWorkingDirectory || null,
      };
    } else {
      this.state = {
        runId,
        profile: opts.profile || null,
        status: 'running',
        currentStage: null,
        stages: {},
        pause: null,
        sideEffects: [],
        humanRevisions: [],
        metadata: {},
        workingDirectory: null,
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
    } else if (typeof this.state.status === 'string' && this.state.status.startsWith('PAUSED_')) {
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

  setMetadata(key, value) {
    if (!key || typeof key !== 'string') {
      throw new Error('setMetadata(key, value) requires a non-empty string key.');
    }

    if (!this.state.metadata || typeof this.state.metadata !== 'object') {
      this.state.metadata = {};
    }

    if (value === undefined) {
      delete this.state.metadata[key];
    } else {
      this.state.metadata[key] = value;
    }

    this.state.updatedAt = nowIso();
    this.#persistRun();
  }

  getMetadata(key) {
    if (!key || typeof key !== 'string') {
      return undefined;
    }
    return this.state.metadata?.[key];
  }

  setWorkingDirectory(workingDirectory, options = {}) {
    const normalized = typeof workingDirectory === 'string' && workingDirectory.trim()
      ? path.resolve(workingDirectory.trim())
      : null;

    if (!normalized) {
      throw new Error('setWorkingDirectory(workingDirectory) requires a non-empty path string.');
    }

    this.state.workingDirectory = normalized;
    if (options.base) {
      this.state.metadata = {
        ...(this.state.metadata || {}),
        baseWorkingDirectory: normalized,
      };
    }
    this.state.updatedAt = nowIso();
    this.#persistRun();
  }

  getWorkingDirectory() {
    return this.state.workingDirectory
      || this.state.metadata?.worktreePath
      || this.state.metadata?.baseWorkingDirectory
      || null;
  }

  setWorktree({ worktreePath, branchName, baseWorkingDirectory = null } = {}) {
    if (!worktreePath || typeof worktreePath !== 'string') {
      throw new Error('setWorktree({ worktreePath, branchName }) requires worktreePath.');
    }

    const normalizedWorktree = path.resolve(worktreePath);
    this.state.workingDirectory = normalizedWorktree;
    this.state.metadata = {
      ...(this.state.metadata || {}),
      worktreePath: normalizedWorktree,
      worktreeBranch: branchName || null,
      baseWorkingDirectory: baseWorkingDirectory
        ? path.resolve(baseWorkingDirectory)
        : this.state.metadata?.baseWorkingDirectory || null,
    };
    this.state.updatedAt = nowIso();
    this.#persistRun();
  }

  pause(reason, data = null, status = 'PAUSED_HITL') {
    this.state.status = status || 'PAUSED_HITL';
    this.state.pause = {
      reason: reason || null,
      data,
      status: status || 'PAUSED_HITL',
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

  recordSideEffect(effect) {
    if (!effect || typeof effect !== 'object') {
      throw new Error('recordSideEffect(effect) requires an effect object.');
    }

    if (!Array.isArray(this.state.sideEffects)) {
      this.state.sideEffects = [];
    }

    this.state.sideEffects.push({
      ...effect,
      timestamp: effect.timestamp || nowIso(),
    });
    this.state.updatedAt = nowIso();
    this.#persistRun();

    return this.getSideEffects();
  }

  getSideEffects() {
    return Array.isArray(this.state.sideEffects) ? [...this.state.sideEffects] : [];
  }

  addHumanRevision(comments, stageName = null) {
    const normalized = typeof comments === 'string' ? comments.trim() : '';
    if (!normalized) {
      return null;
    }

    if (!Array.isArray(this.state.humanRevisions)) {
      this.state.humanRevisions = [];
    }

    const entry = {
      comments: normalized,
      stage: stageName || this.state.currentStage || null,
      recordedAt: nowIso(),
    };

    this.state.humanRevisions.push(entry);
    this.state.updatedAt = nowIso();
    this.#persistRun();
    return entry;
  }

  getLatestHumanRevision() {
    if (!Array.isArray(this.state.humanRevisions) || this.state.humanRevisions.length === 0) {
      return null;
    }

    return this.state.humanRevisions[this.state.humanRevisions.length - 1];
  }

  resetStages(stageNames) {
    if (!Array.isArray(stageNames) || stageNames.length === 0) {
      return;
    }

    for (const stageName of stageNames) {
      if (!stageName || typeof stageName !== 'string') {
        continue;
      }

      delete this.state.stages[stageName];

      const artifactPath = path.join(this.runDirAbs, `${stageName}.json`);
      try {
        if (fs.existsSync(artifactPath)) {
          fs.unlinkSync(artifactPath);
        }
      } catch {
        // Leave the run resumable even if cleanup is partial.
      }
    }

    if (stageNames.includes(this.state.currentStage)) {
      this.state.currentStage = null;
    }

    if (stageNames.includes('completed')) {
      delete this.state.completedAt;
    }

    if (this.state.status !== 'failed') {
      this.state.status = 'running';
    }

    this.state.pause = null;
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
