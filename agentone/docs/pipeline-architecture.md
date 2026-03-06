# AgentOne Pipeline Architecture — Full Jira-to-PR Pipeline

## 1. Pipeline Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        PIPELINE ORCHESTRATOR                                │
│                     (src/scripts/pipeline.js)                               │
│                                                                             │
│  ┌──────────┐  ┌──────────────┐  ┌─────────────┐  ┌──────────────────────┐ │
│  │  INTAKE   │→│  DUAL PLAN   │→│ CROSS-CRIT  │→│  CONVERGENCE LOOP    │ │
│  │  (Jira)   │  │  (CC + CX)   │  │  (CC ↔ CX)  │  │  (max 4 rounds)    │ │
│  └──────────┘  └──────────────┘  └─────────────┘  └──────────────────────┘ │
│        │                                                     │              │
│        ▼                                                     ▼              │
│  ┌──────────┐                                    ┌──────────────────────┐   │
│  │  GATE:   │                                    │  HUMAN-IN-THE-LOOP  │   │
│  │  ticket  │                                    │  (pause + webhook)   │   │
│  │  valid?  │                                    └──────────────────────┘   │
│  └──────────┘                                               │              │
│                                                             ▼              │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────────┐  │
│  │  PHASED CODING   │→│  PHASE REVIEW    │→│  PHASE LOOP (per phase) │  │
│  │  (Codex builds)  │  │  (CC verifies)   │  │  (retry until CC pass)  │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────────────┘  │
│                                                             │              │
│        ┌────────────────────────────────────────────────────┘              │
│        ▼                                                                   │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │  TESTS   │→│  SECURITY    │→│  PR CREATE   │→│  JIRA UPDATE    │   │
│  │  (suite) │  │  AUDIT (CC)  │  │  (git + gh)  │  │  (mark done)    │   │
│  └──────────┘  └──────────────┘  └──────────────┘  └──────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘

CC = Claude Code    CX = Codex CLI
```

---

## 2. File Structure

```
src/scripts/
├── pipeline.js                  # Main orchestrator (entry point)
├── pipeline-config.js           # Defaults, timeouts, retry limits
├── chain-test.js                # (existing) Two-step test
├── worker-spawner.js            # (existing) Parallel worker executor
│
├── stages/
│   ├── intake.js                # Stage 1: Jira ticket fetch + validation
│   ├── dual-plan.js             # Stage 2: Parallel plan generation (CC + CX)
│   ├── cross-critique.js        # Stage 3-4: Cross-critique convergence loop
│   ├── human-review.js          # Stage 5: Human-in-the-loop gate
│   ├── phased-coding.js         # Stage 6-8: Codex codes, CC reviews, loop
│   ├── test-runner.js           # Stage 9: Test suite execution
│   ├── security-audit.js        # Stage 10: Security audit (CC)
│   ├── pr-creator.js            # Stage 11: Branch, commit, PR
│   └── jira-closer.js           # Stage 12: Update Jira ticket
│
├── lib/
│   ├── bridge-client.js         # Typed wrapper around bridge HTTP API
│   ├── agent-runner.js          # Spawn→poll→extract abstraction
│   ├── state-manager.js         # Checkpoint save/load/resume
│   ├── gate.js                  # Regex + JSON schema validation gates
│   ├── convergence.js           # Diff-based convergence detection
│   └── logger.js                # Structured logging (to run archive)
│
├── prompts/
│   ├── plan-claude.md           # Planning prompt for Claude Code
│   ├── plan-codex.md            # Planning prompt for Codex
│   ├── critique-template.md     # Cross-critique prompt template
│   ├── code-phase.md            # Coding prompt (per phase)
│   ├── review-phase.md          # Review prompt (per phase)
│   ├── security-audit.md        # Security audit prompt
│   └── test-runner.md           # Test execution prompt
│
└── tools/
    └── cli-executor.js          # (existing) Bridge tool for Keen flows

logs/
├── chain-runs/                  # (existing) Chain test archives
└── pipeline-runs/               # Full pipeline run archives
    └── {runId}/
        ├── run.json             # Master run state + metadata
        ├── intake.json          # Stage output
        ├── plan-claude.md       # Claude's plan
        ├── plan-codex.md        # Codex's plan
        ├── critique-round-1.json
        ├── critique-round-2.json
        ├── converged-plan.md    # Final merged plan
        ├── human-decision.json  # Approve/reject + notes
        ├── phase-1-code.json    # Coding output per phase
        ├── phase-1-review.json  # Review output per phase
        ├── test-results.json
        ├── security-report.json
        └── pr.json              # PR URL, branch, commit SHAs
```

---

## 3. Core Abstraction: `agent-runner.js`

Generalizes the spawn→poll→extract pattern from `chain-test.js` into a reusable function. Every stage uses this.

```javascript
// src/scripts/lib/agent-runner.js

/**
 * Spawn a CLI agent, poll until done, extract structured result.
 *
 * @param {Object} opts
 * @param {string} opts.cli          - 'claude' | 'codex' | 'bash'
 * @param {string} opts.prompt       - The instruction to send
 * @param {string} opts.cwd          - Working directory
 * @param {string} opts.label        - Human-readable label for debug dashboard
 * @param {Object} opts.metadata     - {pipelineRunId, agentType, subtaskId, parentSessionId}
 * @param {number} opts.timeout      - Max ms to wait (default: 300_000)
 * @param {number} opts.pollInterval - Poll interval ms (default: 3_000)
 * @param {RegExp} opts.extractRegex - Regex to extract from output (default: /<COMPLETED>([\s\S]*?)<\/COMPLETED>/)
 * @param {string[]} opts.extraArgs  - Additional CLI args
 * @param {boolean} opts.planMode    - Add --permission-mode plan
 * @param {Function} opts.onPoll     - Optional callback on each poll (for progress reporting)
 *
 * @returns {AgentResult}
 *   { sessionId, pid, label, durationMs, exitCode, success,
 *     content, fullOutput, rawStdout, rawStderr,
 *     parsedJson, tokens, costUsd, numTurns, timedOut }
 */
export async function runAgent(opts) { ... }

/**
 * Run two agents in parallel, return both results.
 * Used by dual-plan stage.
 */
export async function runAgentsParallel(agentConfigs) {
  return Promise.all(agentConfigs.map(runAgent))
}
```

**Key behaviors:**
- Wraps the existing bridge `/api/cli/spawn` + `/api/cli/poll` pattern
- Auto-detects Claude JSON output and parses `{result, usage, cost}`
- Falls back to regex extraction if JSON parse fails
- Calls `/api/cli/kill` on timeout
- Returns a normalized `AgentResult` regardless of CLI type
- Logs every spawn/poll/extract to the run logger

---

## 4. State Manager: Checkpoint & Resume

Extends the existing checkpoint pattern from `worker-spawner.js` into a general pipeline state machine.

```javascript
// src/scripts/lib/state-manager.js

const STAGES = [
  'intake',
  'dual-plan',
  'cross-critique',
  'human-review',
  'phased-coding',    // internally loops per phase
  'test-runner',
  'security-audit',
  'pr-creator',
  'jira-closer',
  'completed'
]

export class PipelineState {
  constructor(runId) {
    this.runId = runId
    this.dir = `logs/pipeline-runs/${runId}`
    this.stage = 'intake'
    this.data = {}           // accumulated stage outputs
    this.history = []        // [{stage, startedAt, endedAt, success, error}]
    this.createdAt = new Date().toISOString()
  }

  /** Save checkpoint to disk after each stage completes */
  async checkpoint(stage, stageOutput) {
    this.stage = stage
    this.data[stage] = stageOutput
    this.history.push({ stage, completedAt: now(), success: true })
    await writeJson(`${this.dir}/run.json`, this.serialize())
    await writeJson(`${this.dir}/${stage}.json`, stageOutput)
  }

  /** Load from disk for resume */
  static async resume(runId) {
    const raw = await readJson(`logs/pipeline-runs/${runId}/run.json`)
    return PipelineState.deserialize(raw)
  }

  /** Which stage to start from on resume */
  get resumeStage() {
    const idx = STAGES.indexOf(this.stage)
    return STAGES[idx + 1] || 'completed'
  }

  /** Check if a stage should be skipped (already completed) */
  shouldSkip(stage) {
    return STAGES.indexOf(stage) < STAGES.indexOf(this.resumeStage)
  }
}
```

**Checkpoint files** are plain JSON written to `logs/pipeline-runs/{runId}/`. Each stage writes its own `{stage}.json` artifact plus updates the master `run.json`. This means:
- Crash at any point → resume from last completed stage
- Human can inspect intermediate artifacts (plans, critiques, reviews)
- Run archive is built incrementally, not all-at-once

---

## 5. Inter-Stage Communication Protocol

All stages communicate through **structured JSON artifacts** stored in the `PipelineState.data` object and persisted to disk. No regex gates between stages — regex is only used for extracting output from raw agent stdout (the `<COMPLETED>` pattern).

```
┌────────────┐     stageOutput (JSON)      ┌────────────┐
│  Stage N   │ ──────────────────────────→  │  Stage N+1 │
│            │     via state.data[name]     │            │
└────────────┘                              └────────────┘
       │                                           │
       ▼                                           ▼
  logs/pipeline-runs/{runId}/{stage}.json    reads previous
                                             stage outputs
                                             from state.data
```

### Stage Output Contracts

Each stage returns a well-defined JSON object. The next stage reads what it needs from `state.data`.

```javascript
// intake → dual-plan
{
  ticketId: "PROJ-123",
  ticketUrl: "https://jira.example.com/browse/PROJ-123",
  title: "Add user authentication",
  description: "Full feature description...",
  acceptanceCriteria: ["AC1", "AC2"],
  labels: ["feature", "backend"],
  repo: "git@github.com:org/repo.git",
  branch: "main",
  workingDirectory: "/path/to/repo"
}

// dual-plan → cross-critique
{
  claudePlan: { markdown: "...", tokens: 1234, costUsd: 0.04 },
  codexPlan:  { markdown: "...", tokens: 1100, costUsd: 0.03 },
  elapsed: { claude: 25000, codex: 32000 }  // ms
}

// cross-critique → human-review
{
  rounds: [
    {
      round: 1,
      claudeCritique: { markdown: "...", of: "codex" },
      codexCritique:  { markdown: "...", of: "claude" },
      convergenceScore: 0.42  // 0.0 = total disagreement, 1.0 = identical
    },
    {
      round: 2,
      claudeCritique: { markdown: "..." },
      codexCritique:  { markdown: "..." },
      convergenceScore: 0.87
    }
  ],
  converged: true,
  finalPlan: "# Merged Implementation Plan\n...",
  totalRounds: 2
}

// human-review → phased-coding
{
  decision: "approved" | "rejected" | "modified",
  notes: "Looks good, but skip the caching phase for now",
  modifiedPlan: "...",   // only if decision === "modified"
  reviewedBy: "user@example.com",
  reviewedAt: "2026-03-02T14:30:00Z"
}

// phased-coding → test-runner
{
  phases: [
    {
      id: 1,
      title: "Database schema",
      codingResult: { success: true, files: ["schema.sql"], ... },
      reviewResult: { approved: true, issues: [], ... },
      iterations: 1  // how many code→review cycles
    },
    {
      id: 2,
      title: "API endpoints",
      codingResult: { ... },
      reviewResult: { approved: true, ... },
      iterations: 2  // first attempt had issues, fixed on retry
    }
  ],
  allPhasesComplete: true
}

// test-runner → security-audit
{
  suites: {
    unit: { passed: 142, failed: 0, skipped: 3 },
    integration: { passed: 28, failed: 0, skipped: 0 },
    e2e: { passed: 12, failed: 1, skipped: 0 }
  },
  allPassed: false,
  failureDetails: [{ suite: "e2e", test: "login flow", error: "..." }],
  coveragePct: 87.3
}

// security-audit → pr-creator
{
  findings: [
    { severity: "low", file: "src/auth.js", line: 42, description: "..." }
  ],
  critical: 0,
  high: 0,
  medium: 1,
  low: 2,
  passed: true  // no critical or high findings
}

// pr-creator → jira-closer
{
  prUrl: "https://github.com/org/repo/pull/456",
  prNumber: 456,
  branch: "feature/PROJ-123-user-auth",
  commits: ["abc1234", "def5678"],
  filesChanged: 23,
  additions: 450,
  deletions: 30
}
```

---

## 6. Pipeline Orchestrator

```javascript
// src/scripts/pipeline.js

import { PipelineState } from './lib/state-manager.js'
import { createLogger } from './lib/logger.js'
import * as intake from './stages/intake.js'
import * as dualPlan from './stages/dual-plan.js'
import * as crossCritique from './stages/cross-critique.js'
import * as humanReview from './stages/human-review.js'
import * as phasedCoding from './stages/phased-coding.js'
import * as testRunner from './stages/test-runner.js'
import * as securityAudit from './stages/security-audit.js'
import * as prCreator from './stages/pr-creator.js'
import * as jiraCloser from './stages/jira-closer.js'

const STAGE_MODULES = {
  'intake':         intake,
  'dual-plan':      dualPlan,
  'cross-critique': crossCritique,
  'human-review':   humanReview,
  'phased-coding':  phasedCoding,
  'test-runner':    testRunner,
  'security-audit': securityAudit,
  'pr-creator':     prCreator,
  'jira-closer':    jiraCloser,
}

export async function runPipeline({ ticketId, resumeRunId, config }) {
  // Resume existing run or start fresh
  const state = resumeRunId
    ? await PipelineState.resume(resumeRunId)
    : new PipelineState(generateRunId())

  const log = createLogger(state.runId)

  // Linear stage execution with skip-on-resume
  for (const [name, mod] of Object.entries(STAGE_MODULES)) {
    if (state.shouldSkip(name)) {
      log.info(`Skipping ${name} (already completed)`)
      continue
    }

    log.info(`Starting stage: ${name}`)
    const stageStart = Date.now()

    try {
      const result = await mod.execute({
        state,           // full pipeline state (read previous outputs)
        config,          // pipeline-config.js defaults + overrides
        log,             // structured logger
        runId: state.runId,
        ticketId: ticketId || state.data.intake?.ticketId,
      })

      await state.checkpoint(name, result)
      log.info(`Completed stage: ${name} in ${Date.now() - stageStart}ms`)

      // HALT conditions
      if (name === 'human-review' && result.decision === 'rejected') {
        log.info('Pipeline halted: human rejected the plan')
        await state.checkpoint('completed', { outcome: 'rejected' })
        return state
      }
      if (name === 'security-audit' && !result.passed) {
        log.warn('Security audit failed — critical/high findings')
        // Don't halt, but flag for human review before PR
      }

    } catch (err) {
      log.error(`Stage ${name} failed: ${err.message}`)
      state.history.push({ stage: name, error: err.message, failedAt: now() })
      await state.checkpoint(name + '-FAILED', { error: err.message, stack: err.stack })
      throw err  // Caller decides whether to retry or abort
    }
  }

  await state.checkpoint('completed', { outcome: 'success' })
  log.info(`Pipeline ${state.runId} completed successfully`)
  return state
}
```

**Invocation:**
```bash
# Fresh run from Jira ticket
node src/scripts/pipeline.js --ticket PROJ-123

# Resume a failed/paused run
node src/scripts/pipeline.js --resume run_20260302_143000_abc

# With config overrides
node src/scripts/pipeline.js --ticket PROJ-123 --max-critique-rounds 2 --skip-security
```

---

## 7. Stage Implementations (Detail)

### Stage 1: Intake (`stages/intake.js`)

```javascript
export async function execute({ state, config, log }) {
  const ticketId = state.data.intake?.ticketId || config.ticketId

  // Option A: Jira REST API via bridge /api/web/scrape or direct fetch
  // Option B: Jira MCP tool if running inside Keen
  // Option C: Manual input (JSON file or CLI arg)

  const ticket = await fetchJiraTicket(ticketId, config.jira)

  // Validate: must have title, description, repo
  validateTicket(ticket)

  // Clone or update repo
  const workDir = await prepareWorkingDirectory(ticket.repo, config.workDir)

  return {
    ticketId: ticket.key,
    ticketUrl: ticket.url,
    title: ticket.fields.summary,
    description: ticket.fields.description,
    acceptanceCriteria: extractAC(ticket),
    repo: ticket.repo,
    branch: ticket.baseBranch || 'main',
    workingDirectory: workDir,
  }
}
```

### Stage 2: Dual Plan (`stages/dual-plan.js`)

Two agents run **in parallel**. Each produces a plan in markdown.

```javascript
import { runAgentsParallel } from '../lib/agent-runner.js'
import { loadPrompt } from '../lib/prompts.js'

export async function execute({ state, config, log, runId }) {
  const ticket = state.data.intake
  const cwd = ticket.workingDirectory

  // Load prompt templates, inject ticket context
  const claudePrompt = loadPrompt('plan-claude.md', {
    title: ticket.title,
    description: ticket.description,
    acceptanceCriteria: ticket.acceptanceCriteria,
  })

  const codexPrompt = loadPrompt('plan-codex.md', {
    title: ticket.title,
    description: ticket.description,
    acceptanceCriteria: ticket.acceptanceCriteria,
  })

  // Spawn both in parallel via bridge
  const [claudeResult, codexResult] = await runAgentsParallel([
    {
      cli: 'claude',
      prompt: claudePrompt,
      cwd,
      label: 'Plan-Claude',
      metadata: { pipelineRunId: runId, agentType: 'Planner' },
      timeout: config.planTimeout || 300_000,
    },
    {
      cli: 'codex',
      prompt: codexPrompt,
      cwd,
      label: 'Plan-Codex',
      metadata: { pipelineRunId: runId, agentType: 'Planner' },
      timeout: config.planTimeout || 300_000,
    },
  ])

  // Persist plans as markdown files
  await writeFile(`${state.dir}/plan-claude.md`, claudeResult.content)
  await writeFile(`${state.dir}/plan-codex.md`, codexResult.content)

  return {
    claudePlan: {
      markdown: claudeResult.content,
      tokens: claudeResult.tokens,
      costUsd: claudeResult.costUsd,
    },
    codexPlan: {
      markdown: codexResult.content,
      tokens: codexResult.tokens,
      costUsd: codexResult.costUsd,
    },
    elapsed: {
      claude: claudeResult.durationMs,
      codex: codexResult.durationMs,
    },
  }
}
```

### Stage 3-4: Cross-Critique & Convergence Loop (`stages/cross-critique.js`)

This is the most complex stage. Two agents critique each other's plans iteratively.

```javascript
import { runAgentsParallel } from '../lib/agent-runner.js'
import { detectConvergence } from '../lib/convergence.js'

export async function execute({ state, config, log, runId }) {
  const maxRounds = config.maxCritiqueRounds || 4
  const convergenceThreshold = config.convergenceThreshold || 0.80
  const cwd = state.data.intake.workingDirectory

  let claudePlan = state.data['dual-plan'].claudePlan.markdown
  let codexPlan  = state.data['dual-plan'].codexPlan.markdown
  const rounds = []

  for (let round = 1; round <= maxRounds; round++) {
    log.info(`Cross-critique round ${round}/${maxRounds}`)

    // Each agent reads the OTHER's plan and critiques it,
    // then produces a REVISED version of their OWN plan
    const [claudeResult, codexResult] = await runAgentsParallel([
      {
        cli: 'claude',
        prompt: buildCritiquePrompt({
          ownPlan: claudePlan,
          otherPlan: codexPlan,
          otherName: 'Codex',
          round,
        }),
        cwd,
        label: `Critique-Claude-R${round}`,
        metadata: { pipelineRunId: runId, agentType: 'Critic' },
        timeout: config.critiqueTimeout || 180_000,
      },
      {
        cli: 'codex',
        prompt: buildCritiquePrompt({
          ownPlan: codexPlan,
          otherPlan: claudePlan,
          otherName: 'Claude',
          round,
        }),
        cwd,
        label: `Critique-Codex-R${round}`,
        metadata: { pipelineRunId: runId, agentType: 'Critic' },
        timeout: config.critiqueTimeout || 180_000,
      },
    ])

    // Parse structured output: { critique: "...", revisedPlan: "..." }
    const claudeParsed = parseJsonFromAgent(claudeResult.content)
    const codexParsed  = parseJsonFromAgent(codexResult.content)

    // Update plans for next round
    claudePlan = claudeParsed.revisedPlan
    codexPlan  = codexParsed.revisedPlan

    // Measure convergence: how similar are the two revised plans?
    const score = detectConvergence(claudePlan, codexPlan)

    rounds.push({
      round,
      claudeCritique: { markdown: claudeParsed.critique, revisedPlan: claudePlan },
      codexCritique:  { markdown: codexParsed.critique,  revisedPlan: codexPlan },
      convergenceScore: score,
    })

    log.info(`Round ${round} convergence score: ${score.toFixed(2)}`)

    if (score >= convergenceThreshold) {
      log.info(`Plans converged at round ${round} (score ${score.toFixed(2)} >= ${convergenceThreshold})`)
      break
    }
  }

  // Merge final plans: use Claude to synthesize one plan from both
  const mergeResult = await runAgent({
    cli: 'claude',
    prompt: buildMergePrompt(claudePlan, codexPlan),
    cwd,
    label: 'Plan-Merge',
    metadata: { pipelineRunId: runId, agentType: 'Synthesizer' },
  })

  const finalPlan = mergeResult.content
  await writeFile(`${state.dir}/converged-plan.md`, finalPlan)

  return {
    rounds,
    converged: rounds[rounds.length - 1].convergenceScore >= convergenceThreshold,
    finalPlan,
    totalRounds: rounds.length,
  }
}
```

### Convergence Detection (`lib/convergence.js`)

```javascript
/**
 * Measures how similar two plan documents are.
 * Returns a score from 0.0 (completely different) to 1.0 (identical).
 *
 * Strategy: structural similarity, not string diff.
 * 1. Extract section headings from both plans
 * 2. Extract key decisions (tech choices, file paths, patterns)
 * 3. Compare section overlap (Jaccard similarity)
 * 4. Compare decision overlap
 * 5. Weighted average: 40% structure + 60% decisions
 */
export function detectConvergence(planA, planB) {
  const sectionsA = extractSections(planA)
  const sectionsB = extractSections(planB)
  const structureScore = jaccardSimilarity(sectionsA, sectionsB)

  const decisionsA = extractDecisions(planA)
  const decisionsB = extractDecisions(planB)
  const decisionScore = jaccardSimilarity(decisionsA, decisionsB)

  return 0.4 * structureScore + 0.6 * decisionScore
}

// Alternatively: ask an LLM to rate convergence (more accurate, costs tokens)
export async function detectConvergenceLLM(planA, planB, bridgeClient) {
  const result = await bridgeClient.runAgent({
    cli: 'claude',
    prompt: `Rate from 0.0 to 1.0 how similar these two implementation plans are.
Focus on: same architectural decisions, same file structure, same tech choices,
same implementation order. Output ONLY a JSON: {"score": 0.XX, "reasoning": "..."}

Plan A:
${planA}

Plan B:
${planB}`,
    label: 'Convergence-Check',
  })
  return JSON.parse(result.content).score
}
```

### Stage 5: Human-in-the-Loop (`stages/human-review.js`)

Three mechanisms, configurable:

```javascript
export async function execute({ state, config, log, runId }) {
  const plan = state.data['cross-critique'].finalPlan
  const mode = config.humanReviewMode || 'file-poll'  // 'file-poll' | 'webhook' | 'cli-prompt'

  log.info(`Waiting for human review (mode: ${mode})`)
  log.info(`Plan written to: ${state.dir}/converged-plan.md`)

  if (mode === 'file-poll') {
    // Write plan + empty decision file, poll until human fills it
    const decisionPath = `${state.dir}/human-decision.json`
    await writeFile(decisionPath, JSON.stringify({
      _instruction: "Edit this file to approve or reject the plan.",
      _options: "Set decision to: 'approved', 'rejected', or 'modified'",
      _plan: `See: ${state.dir}/converged-plan.md`,
      decision: null,
      notes: "",
      modifiedPlan: null,
    }, null, 2))

    // Poll file until decision !== null
    return await pollForDecision(decisionPath, {
      interval: config.humanPollInterval || 10_000,
      timeout: config.humanTimeout || 86_400_000,  // 24h default
      log,
    })
  }

  if (mode === 'webhook') {
    // POST plan to configured webhook URL, wait for callback
    const callbackId = crypto.randomUUID()
    await postWebhook(config.humanWebhookUrl, {
      runId,
      callbackId,
      plan,
      callbackUrl: `http://localhost:3222/api/pipeline/callback/${callbackId}`,
    })

    // Bridge registers a one-shot callback endpoint
    return await waitForCallback(callbackId, config.humanTimeout || 86_400_000)
  }

  if (mode === 'cli-prompt') {
    // Print plan to console, read stdin
    console.log('\n' + '='.repeat(60))
    console.log('PLAN FOR REVIEW:')
    console.log('='.repeat(60))
    console.log(plan)
    console.log('='.repeat(60))
    const decision = await promptUser('Approve? (y/n/m for modify): ')
    // ...
  }
}
```

### Stage 6-8: Phased Coding + Review Loop (`stages/phased-coding.js`)

The converged plan is split into phases. Each phase: Codex codes → Claude reviews → loop if issues.

```javascript
export async function execute({ state, config, log, runId }) {
  const plan = state.data['human-review'].modifiedPlan
    || state.data['cross-critique'].finalPlan
  const cwd = state.data.intake.workingDirectory
  const maxReviewIterations = config.maxReviewIterations || 3

  // Extract phases from plan (numbered sections)
  const phases = extractPhases(plan)
  const results = []

  for (const phase of phases) {
    log.info(`Phase ${phase.id}: ${phase.title}`)

    let approved = false
    let iteration = 0
    let codingResult, reviewResult
    let previousReview = null

    while (!approved && iteration < maxReviewIterations) {
      iteration++
      log.info(`  Iteration ${iteration}/${maxReviewIterations}`)

      // CODEX CODES the phase
      codingResult = await runAgent({
        cli: 'codex',
        prompt: buildCodingPrompt({
          phase,
          fullPlan: plan,
          previousReview,  // null on first pass, feedback on retries
          cwd,
        }),
        cwd,
        label: `Code-Phase${phase.id}-Iter${iteration}`,
        metadata: { pipelineRunId: runId, agentType: 'Coder', subtaskId: `phase-${phase.id}` },
        timeout: config.codingTimeout || 600_000,
      })

      // CLAUDE REVIEWS the phase
      reviewResult = await runAgent({
        cli: 'claude',
        prompt: buildReviewPrompt({
          phase,
          fullPlan: plan,
          cwd,
        }),
        cwd,
        label: `Review-Phase${phase.id}-Iter${iteration}`,
        metadata: { pipelineRunId: runId, agentType: 'Reviewer', subtaskId: `phase-${phase.id}` },
        timeout: config.reviewTimeout || 300_000,
      })

      // Parse review: { approved: bool, issues: [...], summary: "..." }
      const review = parseJsonFromAgent(reviewResult.content)
      approved = review.approved
      previousReview = review

      if (!approved) {
        log.warn(`  Phase ${phase.id} not approved: ${review.issues.length} issues`)
      }
    }

    if (!approved) {
      log.error(`Phase ${phase.id} failed after ${maxReviewIterations} iterations`)
      // Don't abort — record failure, continue to next phase
      // Human can inspect and decide
    }

    results.push({
      id: phase.id,
      title: phase.title,
      codingResult: summarizeAgentResult(codingResult),
      reviewResult: summarizeAgentResult(reviewResult),
      approved,
      iterations: iteration,
    })

    // Checkpoint per phase (allows resume mid-coding)
    await state.checkpoint('phased-coding', { phases: results, allPhasesComplete: false })
  }

  return { phases: results, allPhasesComplete: results.every(r => r.approved) }
}
```

### Stage 9: Test Runner (`stages/test-runner.js`)

```javascript
export async function execute({ state, config, log, runId }) {
  const cwd = state.data.intake.workingDirectory

  // Use Claude to discover and run tests
  const result = await runAgent({
    cli: 'claude',
    prompt: loadPrompt('test-runner.md', {
      workingDirectory: cwd,
      testCommand: config.testCommand,  // optional override
    }),
    cwd,
    label: 'Test-Runner',
    metadata: { pipelineRunId: runId, agentType: 'Tester' },
    timeout: config.testTimeout || 600_000,
  })

  // Parse: { suites: {...}, allPassed: bool, failureDetails: [...] }
  return parseJsonFromAgent(result.content)
}
```

### Stage 10: Security Audit (`stages/security-audit.js`)

```javascript
export async function execute({ state, config, log, runId }) {
  const cwd = state.data.intake.workingDirectory

  const result = await runAgent({
    cli: 'claude',
    prompt: loadPrompt('security-audit.md', {
      workingDirectory: cwd,
      focusAreas: config.securityFocusAreas || ['OWASP Top 10', 'dependency audit', 'secrets scan'],
    }),
    cwd,
    label: 'Security-Audit',
    metadata: { pipelineRunId: runId, agentType: 'Auditor' },
    timeout: config.auditTimeout || 300_000,
  })

  return parseJsonFromAgent(result.content)
}
```

### Stage 11-12: PR + Jira (`stages/pr-creator.js`, `stages/jira-closer.js`)

```javascript
// pr-creator.js — Uses Claude with bash/git/gh tools
export async function execute({ state, config, log, runId }) {
  const ticket = state.data.intake
  const branchName = `feature/${ticket.ticketId.toLowerCase()}`

  const result = await runAgent({
    cli: 'claude',
    prompt: `Create a PR for the work done on ${ticket.ticketId}.
Branch: ${branchName}
Base: ${ticket.branch}
Title: ${ticket.ticketId}: ${ticket.title}
Include a summary of all changes. Use gh pr create.
Output JSON: { prUrl, prNumber, branch, filesChanged, additions, deletions }`,
    cwd: ticket.workingDirectory,
    label: 'PR-Creator',
    metadata: { pipelineRunId: runId, agentType: 'Deployer' },
  })

  return parseJsonFromAgent(result.content)
}
```

---

## 8. Bridge Client (`lib/bridge-client.js`)

Typed wrapper over the raw HTTP calls, replacing the ad-hoc `bridgeCall()` in chain-test.

```javascript
// src/scripts/lib/bridge-client.js

const DEFAULT_BRIDGE = 'http://localhost:3222'
const TOKEN = process.env.BRIDGE_TOKEN || 'b3d6d5c1a50155e207c503102f7bc610'

export class BridgeClient {
  constructor(baseUrl = DEFAULT_BRIDGE) {
    this.baseUrl = baseUrl
  }

  async spawn(cli, args, { cwd, closeStdin, metadata } = {}) { ... }
  async poll(sessionId, interval = 3000) { ... }
  async send(sessionId, input) { ... }
  async output(sessionId, full = false) { ... }
  async history(sessionId) { ... }
  async wait(sessionId, timeout) { ... }
  async kill(sessionId) { ... }
  async killByFilter(filter) { ... }
  async list() { ... }
  async status(sessionId) { ... }
  async writeFile(path, content) { ... }
  async readFile(path) { ... }
}
```

---

## 9. Gate System (`lib/gate.js`)

Gates validate stage outputs before proceeding. Two types:

```javascript
// Regex gate: extract structured content from raw agent output
export function regexGate(output, pattern = /<COMPLETED>([\s\S]*?)<\/COMPLETED>/) {
  const match = output.match(pattern)
  if (!match) throw new GateError(`Output did not match pattern: ${pattern}`)
  return match[1].trim()
}

// Schema gate: validate JSON shape of stage output
export function schemaGate(data, requiredFields) {
  for (const field of requiredFields) {
    if (data[field] === undefined) {
      throw new GateError(`Missing required field: ${field}`)
    }
  }
  return data
}

// Approval gate: check a boolean condition
export function approvalGate(data, field, message) {
  if (!data[field]) throw new GateError(message)
  return data
}
```

Usage in stages:
```javascript
// In agent-runner.js — extract from raw output
const content = regexGate(rawStdout)

// In phased-coding.js — validate review output
schemaGate(review, ['approved', 'issues', 'summary'])

// In security-audit.js — block PR if critical findings
approvalGate(audit, 'passed', 'Security audit has critical/high findings')
```

---

## 10. Prompt Templates (`prompts/`)

Prompts are markdown files with `{{variable}}` placeholders, loaded by a simple template engine.

```javascript
// lib/prompts.js
export function loadPrompt(filename, vars = {}) {
  let template = fs.readFileSync(`src/scripts/prompts/${filename}`, 'utf-8')
  for (const [key, val] of Object.entries(vars)) {
    const value = Array.isArray(val) ? val.map(v => `- ${v}`).join('\n') : String(val)
    template = template.replaceAll(`{{${key}}}`, value)
  }
  return template
}
```

**Example: `prompts/critique-template.md`**
```markdown
You are reviewing an implementation plan written by {{otherName}}.

## Your Current Plan
{{ownPlan}}

## {{otherName}}'s Plan
{{otherPlan}}

## Instructions
1. Read {{otherName}}'s plan carefully
2. Identify strengths and weaknesses
3. Compare with your own plan
4. Produce a revised version of YOUR plan incorporating the best ideas from both

Output EXACTLY this JSON (no other text):
<COMPLETED>
{
  "critique": "Your critique of {{otherName}}'s plan as markdown...",
  "revisedPlan": "Your revised plan as markdown..."
}
</COMPLETED>
```

---

## 11. Error Handling & Recovery

### Error Categories

| Category | Example | Recovery |
|----------|---------|----------|
| Agent timeout | Claude takes >5min | Kill session, retry once with shorter prompt |
| Agent crash | Exit code != 0 | Log stderr, retry once, then fail stage |
| Gate failure | No `<COMPLETED>` tag | Try parsing raw output, retry with explicit instructions |
| Bridge down | Connection refused | Retry with backoff (1s, 2s, 4s), max 3 attempts |
| Convergence failure | Plans don't converge in N rounds | Proceed with best-scored round, flag for human review |
| Human timeout | No response in 24h | Send reminder webhook, keep waiting |
| Test failure | Tests don't pass | Return to phased-coding with failure details |
| Security critical | Critical finding | Block PR creation, require human override |

### Retry Logic (in `agent-runner.js`)

```javascript
async function runAgentWithRetry(opts, maxRetries = 1) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await runAgent(opts)
      if (!result.success && attempt < maxRetries) {
        log.warn(`Attempt ${attempt + 1} failed, retrying...`)
        continue
      }
      return result
    } catch (err) {
      if (attempt === maxRetries) throw err
      log.warn(`Attempt ${attempt + 1} error: ${err.message}, retrying...`)
      await sleep(2000 * (attempt + 1))  // backoff
    }
  }
}
```

### Poison Pill Protection

If a stage fails repeatedly, don't retry forever:
```javascript
// In pipeline.js
const MAX_STAGE_RETRIES = 2
let stageRetries = 0

// On stage failure:
if (stageRetries < MAX_STAGE_RETRIES) {
  stageRetries++
  log.warn(`Retrying stage ${name} (attempt ${stageRetries})`)
  // re-run current stage
} else {
  log.error(`Stage ${name} failed after ${MAX_STAGE_RETRIES} retries — halting`)
  await state.checkpoint(`${name}-FAILED`, { ... })
  throw new PipelineError(`Stage ${name} permanently failed`)
}
```

---

## 12. Configuration (`pipeline-config.js`)

```javascript
export const DEFAULT_CONFIG = {
  // Bridge
  bridgeUrl: process.env.BRIDGE_URL || 'http://localhost:3222',
  bridgeToken: process.env.BRIDGE_TOKEN || 'b3d6d5c1a50155e207c503102f7bc610',

  // Jira
  jira: {
    baseUrl: process.env.JIRA_URL,
    apiToken: process.env.JIRA_TOKEN,
    email: process.env.JIRA_EMAIL,
  },

  // Timeouts (ms)
  planTimeout: 300_000,       // 5 min per planner
  critiqueTimeout: 180_000,   // 3 min per critique round
  codingTimeout: 600_000,     // 10 min per coding phase
  reviewTimeout: 300_000,     // 5 min per review
  testTimeout: 600_000,       // 10 min for test suite
  auditTimeout: 300_000,      // 5 min for security audit

  // Convergence
  maxCritiqueRounds: 4,
  convergenceThreshold: 0.80,

  // Review
  maxReviewIterations: 3,

  // Human-in-the-loop
  humanReviewMode: 'file-poll',  // 'file-poll' | 'webhook' | 'cli-prompt'
  humanPollInterval: 10_000,
  humanTimeout: 86_400_000,      // 24h
  humanWebhookUrl: null,

  // CLI defaults
  defaultCli: 'claude',
  codexCli: 'codex',

  // Test
  testCommand: null,  // auto-detect if null

  // Security
  securityFocusAreas: ['OWASP Top 10', 'dependency audit', 'secrets scan'],

  // Agent tools (allowed in Claude --allowedTools)
  allowedTools: ['Bash', 'Edit', 'Read', 'Write', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
}
```

---

## 13. Modularity — Swapping Agents

The `agent-runner.js` abstraction means any CLI that accepts a prompt and produces text output can be used. To swap an LLM:

1. **Change the `cli` field** in the stage config:
   ```javascript
   // Use GPT-4 via a hypothetical CLI wrapper instead of Codex
   { cli: 'gpt4-cli', prompt: '...', ... }
   ```

2. **Custom CLI adapters** can be added by extending the bridge spawn logic. The bridge already accepts any `cli` string and spawns it as a subprocess.

3. **Per-stage CLI override** in config:
   ```javascript
   config.stageOverrides = {
     'dual-plan': { claudeCli: 'claude', codexCli: 'codex' },
     'phased-coding': { coderCli: 'codex', reviewerCli: 'claude' },
     'security-audit': { cli: 'claude' },
   }
   ```

4. **Prompt templates** are separate from stage logic, so changing the LLM just means writing a new prompt file — not changing orchestration code.

---

## 14. Observability

### Debug Dashboard (existing `/debug`)

Already shows sessions, PIDs, agent types, conversation history. Pipeline integration:
- All spawned agents carry `pipelineRunId` metadata → filter by run
- `agentType` = Planner | Critic | Synthesizer | Coder | Reviewer | Tester | Auditor | Deployer
- Debug dashboard groups and color-codes by agent type

### Run Archive

```
logs/pipeline-runs/{runId}/
├── run.json              # Master state (stages, timing, costs)
├── intake.json           # Ticket data
├── plan-claude.md        # Claude's plan (human-readable)
├── plan-codex.md         # Codex's plan (human-readable)
├── critique-round-1.json # Round 1 critiques
├── converged-plan.md     # Final merged plan
├── human-decision.json   # Human approval/rejection
├── phase-1-code.json     # Coding artifacts per phase
├── phase-1-review.json   # Review artifacts per phase
├── test-results.json     # Test suite output
├── security-report.json  # Audit findings
├── pr.json               # PR URL and metadata
└── run-log.jsonl         # Structured event log (newline-delimited JSON)
```

### Cost Tracking

Every `AgentResult` includes token usage and cost. The state manager accumulates:
```javascript
state.totalCostUsd = Object.values(state.data)
  .reduce((sum, stage) => sum + (stage.costUsd || 0), 0)
```

---

## 15. Data Flow Summary

```
                        ┌──────────────────────────────────────────┐
                        │           PIPELINE STATE                  │
                        │         (logs/pipeline-runs/{runId}/)     │
                        └──────────────────────────────────────────┘
                                          │
    ┌─────────┐    ticket JSON     ┌──────┴──────┐
    │  JIRA   │ ──────────────→    │   INTAKE    │
    └─────────┘                    └──────┬──────┘
                                          │  {ticketId, title, desc, repo, workDir}
                                          ▼
                                   ┌─────────────┐
                            ┌──────│  DUAL PLAN  │──────┐
                            │      └─────────────┘      │
                     claude │                            │ codex
                     prompt │                            │ prompt
                            ▼                            ▼
                     ┌────────────┐              ┌────────────┐
                     │  CC Agent  │              │  CX Agent  │
                     │  (bridge)  │              │  (bridge)  │
                     └──────┬─────┘              └──────┬─────┘
                            │ plan-claude.md            │ plan-codex.md
                            └──────────┬───────────────┘
                                       ▼
                              ┌─────────────────┐
                              │  CROSS-CRITIQUE  │ ←─── convergence.js
                              │  (loop 1-4x)     │       score >= 0.80?
                              └────────┬────────┘
                                       │ converged-plan.md
                                       ▼
                              ┌─────────────────┐
                              │  HUMAN REVIEW   │ ←─── file-poll / webhook
                              │  (pause & wait)  │
                              └────────┬────────┘
                                       │ decision: approved/modified/rejected
                                       ▼
                              ┌─────────────────┐
                              │ PHASED CODING   │ ←─── per phase loop
                              │ CX codes→CC rev │
                              └────────┬────────┘
                                       │ phase results
                                       ▼
                              ┌─────────────────┐
                              │  TEST RUNNER    │
                              └────────┬────────┘
                                       │ test results
                                       ▼
                              ┌─────────────────┐
                              │ SECURITY AUDIT  │
                              └────────┬────────┘
                                       │ audit report
                                       ▼
                              ┌─────────────────┐
                              │  PR CREATOR     │
                              └────────┬────────┘
                                       │ prUrl
                                       ▼
                              ┌─────────────────┐
                              │  JIRA CLOSER    │
                              └─────────────────┘
```

---

## 16. Implementation Order

Build this incrementally, each step testable independently:

1. **`lib/bridge-client.js`** — Extract from chain-test's `bridgeCall()`, type it, add all endpoints
2. **`lib/agent-runner.js`** — Extract from chain-test's `spawnAndWaitForCompleted()`, generalize
3. **`lib/state-manager.js`** — Checkpoint/resume, extend from worker-spawner pattern
4. **`lib/gate.js`** + **`lib/convergence.js`** — Pure functions, easy to unit test
5. **`stages/intake.js`** — Start simple: read ticket from JSON file, not Jira API
6. **`stages/dual-plan.js`** — First real parallel spawn (test with 2x Claude if no Codex)
7. **`stages/cross-critique.js`** — Convergence loop (test with mock plans first)
8. **`stages/human-review.js`** — File-poll mode first (simplest)
9. **`pipeline.js`** — Wire stages 1-5 together, test end-to-end
10. **`stages/phased-coding.js`** — Code→Review loop
11. **`stages/test-runner.js`** + **`stages/security-audit.js`**
12. **`stages/pr-creator.js`** + **`stages/jira-closer.js`**
13. **Jira API integration** in intake (replace JSON file input)
14. **Webhook mode** for human-review
15. **Dashboard enhancements** — Pipeline-level view in `/debug`

---

<COMPLETED>PLAN READY</COMPLETED>
