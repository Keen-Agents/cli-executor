# AgentOne Pipeline — Full Walkthrough

## What Is This?

AgentOne is a **multi-agent pipeline** that takes a task (Jira ticket or plain text) and autonomously plans, critiques, implements, tests, and ships it — using **Claude and Codex together**. It has an interactive REPL (`npm run agent`) where both models run on every prompt and you can toggle between their outputs.

---

## Architecture Overview

```
                         +------------------+
                         |   Keen CLI REPL   |
                         |  (npm run agent)  |
                         +--------+---------+
                                  |
                    /model claude  |  /model codex
                                  |
                  +---------------+----------------+
                  |                                |
          [Primary Model]                  [Secondary Model]
          streams to screen               runs in background
                  |                        Ctrl+T to view
                  |
                  v
         +------------------+
         |   Orchestrator   |  (prompts/orchestrator.md)
         |  picks profile   |
         +--------+---------+
                  |
    +-------------+-------------+-------------+
    |             |             |             |
  simple      standard      complex       research
  ($15)        ($60)        ($150)         ($30)
```

---

## The Four Profiles

### Simple — Single Agent, No Review
```
intake → classify → plan → implement → verify → pr-create → jira-close
```
- **Budget:** $15 | **Fix attempts:** 1 | **Critique rounds:** 0
- **Use when:** Typos, single-file changes, small fixes
- **Agents:** Claude only

### Standard — With Critique + Human Approval
```
intake → classify → plan → cross-critique → human-gate → implement →
verify → fix-loop → test-suite → browser-test → security-audit →
pr-create → jira-close
```
- **Budget:** $60 | **Fix attempts:** 2 | **Critique rounds:** 1
- **Use when:** Features, refactors, anything needing review
- **Agents:** Claude (multiple stages)

### Complex — Dual Agents + Adversarial Critique
```
intake → classify → research → dual-plan → cross-critique → human-gate →
implement → verify → fix-loop → test-suite → browser-test →
security-audit → human-gate → pr-create → jira-close
```
- **Budget:** $150 | **Fix attempts:** 3 | **Critique rounds:** 2
- **Use when:** Multi-component work, "use Claude and Codex together"
- **Agents:** Claude + Codex in parallel, adversarial reviewer
- **Two human approval gates** (before implement, before PR)

### Research — Information Only
```
intake → classify → research
```
- **Budget:** $30 | No code output
- **Use when:** "Research best frameworks for X", "compare options"
- **Agents:** 3 parallel Claude research agents

---

## Stage-by-Stage Breakdown

### 1. Intake
**What:** Grabs the task — either from Jira REST API or plain text prompt.
**Output:** Normalized ticket object (key, summary, description, priority, labels, working directory, git repo, base branch).
**No agent spawned** — just HTTP calls to Jira or synthetic ticket from `--prompt`.

### 2. Classify
**What:** Picks the right profile (simple/standard/complex) based on heuristics.
**Rules:**
- Security/architecture labels → complex
- Story points >= 8 → complex
- Long description or subtasks → standard
- Bug with high priority → standard
- Everything else → standard (safe default)

**No agent spawned** — pure rule engine.

### 3. Research *(complex + research profiles)*
**What:** Spawns **3 Claude agents in parallel**, each with web search tools:
1. **Landscape** — "What options exist?"
2. **Tradeoffs** — "What are the limitations?"
3. **Recommendation** — "What would you recommend?"

**Output:** Merged research summary from all 3 angles.

### 4. Plan / Dual-Plan

**Simple/Standard — Single Plan (Claude only):**
Claude gets `plan.md` template with ticket details. Produces architecture analysis, implementation steps, edge cases, testing strategy.

**Complex — Dual Plan (Claude + Codex in parallel):**
```
         +---> Claude (plan-claude.md)
         |     Focus: architecture, risk, separation of concerns
  ticket |
         +---> Codex (plan-codex.md)
               Focus: concrete code changes, function signatures, commands
```
Both run simultaneously via `Promise.allSettled`. Their outputs are **merged** into a combined plan. If one fails, the other's plan is used alone.

- **Claude's prompt:** "Think architecturally — affected files, edge cases, error handling, backward compatibility"
- **Codex's prompt:** "Be concrete — function signatures, line-level changes, npm commands, test commands"

### 5. Cross-Critique
**What:** Iterative refinement loop that sharpens the plan.

```
Round 1:  Critic agent reads plan → produces critique
          Revisor agent reads plan + critique → produces revised plan
          Check convergence (phrases like "solid plan", "no major concerns")

Round 2:  (if not converged) Repeat with updated plan
          Check change ratio — if < 10% changed, declare converged
```

- **Standard:** 1 round max, normal critique (`critique.md`)
- **Complex:** 2 rounds max, **adversarial** critique (`critique-adversarial.md`)

**Adversarial mode:** "Tear the plan apart. Challenge every assumption. Do NOT agree easily. Only declare convergence when genuinely no substantive issues remain."

### 6. Human Gate
**What:** Pauses pipeline and waits for human approval.

Writes `human-decision-request.json` to the run directory. The orchestrator (or you manually) reads it and writes back:
```json
{"decision": "approve"}
{"decision": "revise", "comments": "Add error handling for X"}
{"decision": "reject"}
```
- **Approve** → continue to implement
- **Revise** → goes back to planning with your feedback
- **Reject** → pipeline stops

**Complex profile has TWO gates:** one before implementing, one before creating the PR.

### 7. Implement
**What:** The actual code writing.

1. Creates a **git worktree** (isolated branch: `pipeline/{runId}/{ticketKey}`)
2. Renders `implement.md` with the approved plan + ticket details
3. Spawns Claude in the worktree directory
4. Claude writes code, runs commands, creates files
5. Extracts summary from `<COMPLETED>` tag

**Always uses Claude** — Codex's sandbox mode is read-only and can't write files.

### 8. Verify
**What:** Automated quality checks on the implementation.

Runs sequentially:
1. `npm test` — unit tests
2. `npm run lint` — linting
3. `npm audit --json` — dependency vulnerabilities

**Fail-closed:** If any check errors out (can't parse, crashes), it counts as a failure.

On standard/complex profiles, also spawns a **Claude AI code review** that reads the git diff and provides advisory feedback.

### 9. Fix Loop
**What:** If verify failed, tries to fix it automatically.

```
Attempt 1: Claude reads test failures → writes fixes → re-verify
Attempt 2: Claude reads updated failures → writes fixes → re-verify
Attempt 3: (complex only) One more try
```

- Stops on first passing verification
- Uses the latest verify output (not stale data from earlier)
- **simple:** 1 attempt | **standard:** 2 | **complex:** 3

### 10. Test Suite
**What:** Claude generates and runs a comprehensive test plan based on the implementation.
Receives the ticket, plan, and implement summary. Produces test strategy and results.

### 11. Browser Test
**What:** E2E browser testing via Playwright.

1. Detects app URL from implement output (looks for `localhost:XXXX`)
2. Spawns Claude with `browser-test.md` — instructions for using the bridge's 9 browser endpoints:
   - launch, navigate, click, type, screenshot, content, evaluate, close, list
3. Claude automates the browser: opens app, interacts, takes screenshots, verifies behavior
4. Reports PASS / FAIL / SKIP (SKIP if not a web app)

**Requires:** Local bridge running (`node local-bridge.js`) with Playwright installed.

### 12. Security Audit
**What:** AI-powered security review.

1. Collects `git diff` (capped at 80KB) and `npm audit` output
2. Renders `security-audit.md` with the code changes
3. Claude analyzes for OWASP vulnerabilities, injection, XSS, secrets, etc.
4. Counts CRITICAL and HIGH findings — these determine pass/fail

### 13. PR Create
**What:** Ships the code.

1. Commits all changes to the worktree branch
2. Pushes to origin
3. Creates PR via `gh pr create` with verification summary in body
4. Records PR URL, number, branch, SHA

### 14. Jira Close
**What:** Closes the loop on the ticket.

1. Adds comment to Jira with PR link
2. Adds remote link (GitHub PR → Jira ticket)
3. Transitions ticket to "In Review" / "Done" / "Closed"
4. **Skipped** for prompt-mode runs (no Jira ticket)

---

## Auto-Upgrade

The pipeline can **upgrade** its profile mid-flight (never downgrade):

| Trigger | Upgrade |
|---------|---------|
| Diff exceeds 200 lines | simple → standard |
| Security concerns or multi-component deps detected | standard → complex |
| Budget hits 80% | any → paused (human intervention) |

When an upgrade happens, the stage list is rebuilt and execution continues from the current position.

---

## The Interactive REPL

```bash
npm run agent
```

### Dual-Model System
Every prompt you type runs through **both** Claude and Codex simultaneously:
- **Primary model** streams its response to your screen
- **Secondary model** runs the same prompt in the background
- Press `Ctrl+T` to toggle and see what the other model thinks

### Commands

| Command | Action |
|---------|--------|
| `/model claude` | Set Claude as primary |
| `/model codex` | Set Codex as primary |
| `/model` | Toggle between them |
| `/thinking` or `Ctrl+T` | View secondary model's output |
| `/help` | Show all commands |
| `/clear` | Clear screen |
| Tab | Autocomplete commands |

### UI Layout
```
╔══════════════════════╗
║       Keen CLI       ║
╚══════════════════════╝
workdir /path/to/project
model   claude (secondary: codex)

> your prompt here
[model response streams here...]

────────────────────────────────
[claude] > _
  ↵ send  ^C exit  ^L clear  ↑↓ history  ^T thinking  codex: done
```

The orchestrator decides whether to answer directly or launch the full pipeline based on task complexity.

---

## Infrastructure

### Local Bridge (`node local-bridge.js`)
HTTP server on port 3222 that manages everything:

- **CLI Sessions** — spawn/poll/kill Claude and Codex processes with PID tracking
- **File Operations** — read/write/list files
- **Web Scraping** — DuckDuckGo search, URL scraping, RSS news
- **Browser Automation** — 9 Playwright endpoints (launch, navigate, click, type, screenshot, content, evaluate, close, list)
- **Debug Dashboard** — `GET /debug` for live session monitoring with kill buttons

### Checkpoint System
Every stage saves its output to `logs/pipeline-runs/{runId}/`. If a run crashes, you can resume:
```bash
node src/scripts/pipeline.js --resume --run-id {RUN_ID}
```

### Cost Tracking
Each agent records token usage. Budget thresholds:
- **80%** — warning logged
- **100%** — hard pause, requires human intervention

---

## Running It

### From Jira
```bash
node src/scripts/pipeline.js --ticket PROJ-123
```

### From plain text
```bash
node src/scripts/pipeline.js --prompt "Add pagination to the users API" --workdir /path/to/project
```

### Force a profile
```bash
node src/scripts/pipeline.js --prompt "..." --workdir "..." --profile complex
```

### Interactive mode
```bash
npm run agent
```

---

## File Map

```
agentone/
├── ago.js                          # CLI entry point (ago "task")
├── local-bridge.js                 # HTTP bridge server (port 3222)
├── keen-tools.json                 # Tool definitions (CLI Executor, Browser Automation)
├── src/scripts/
│   ├── interactive.js              # REPL with dual-model support
│   ├── pipeline.js                 # Pipeline orchestrator (stage runner)
│   ├── pipeline-config.js          # Profiles, budgets, timeouts, agent defaults
│   ├── worker-spawner.js           # Parallel worker management
│   ├── lib/
│   │   └── agent-runner.js         # Spawn → poll → extract agent results
│   ├── stages/
│   │   ├── intake.js               # Jira fetch / prompt parse
│   │   ├── classify.js             # Profile selection heuristics
│   │   ├── research.js             # 3-agent parallel web research
│   │   ├── plan.js                 # Single-agent planning (Claude)
│   │   ├── dual-plan.js            # Dual-agent planning (Claude + Codex)
│   │   ├── cross-critique.js       # Iterative critique-revision loop
│   │   ├── human-gate.js           # Human approval polling
│   │   ├── implement.js            # Code generation in git worktree
│   │   ├── verify.js               # npm test + lint + audit + AI review
│   │   ├── fix-loop.js             # Auto-fix failing tests
│   │   ├── test-suite.js           # AI test strategy generation
│   │   ├── browser-test.js         # Playwright E2E testing
│   │   ├── security-audit.js       # AI security analysis
│   │   ├── pr-create.js            # Git push + GitHub PR
│   │   └── jira-close.js           # Jira comment + transition
│   ├── prompts/
│   │   ├── orchestrator.md         # REPL system prompt
│   │   ├── plan.md                 # Single-plan template
│   │   ├── plan-claude.md          # Claude plan (architecture focus)
│   │   ├── plan-codex.md           # Codex plan (implementation focus)
│   │   ├── critique.md             # Standard critique template
│   │   ├── critique-adversarial.md # Adversarial critique (complex profile)
│   │   ├── implement.md            # Implementation instructions
│   │   ├── verify.md               # Verification instructions
│   │   ├── fix.md                  # Fix-loop instructions
│   │   ├── test-suite.md           # Test generation instructions
│   │   ├── browser-test.md         # Browser test instructions
│   │   └── security-audit.md       # Security audit instructions
│   └── tools/
│       ├── cli-executor.js         # Keen tool: CLI session management
│       └── browser-automation.js   # Keen tool: Playwright browser control
└── dist/scripts/                   # Compiled copies (mirror of src/)
```
