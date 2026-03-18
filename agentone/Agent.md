# AI Agent Guide: Working with Keen Flow Projects

## Critical Rule

**NEVER read `.flow.json` files directly.** These are monolithic files that can be 12,000+ characters on a single line. Instead, always use the **split flow format** which breaks down the same information into small, focused files.

## Before You Start Building

Before writing any code for a new agent, walk through these questions with the user to identify what's needed:

### 1. What does the agent need to do?
- What is the core task? (e.g., monitor content, process data, answer questions)
- What inputs does it receive? (user messages, scheduled triggers, webhooks)
- What outputs should it produce? (summaries, notifications, data transformations)

### 2. What external services or APIs are involved?
- Which APIs will the agent call? (e.g., YouTube Data API, weather APIs, CRMs)
- What API keys or credentials are needed?
- Are there rate limits or quotas to be aware of?
- Are there free tiers available, or does the user need paid access?

### 3. What data does the user need to provide?
- Configuration values (e.g., list of channels to monitor, email addresses)
- Personal criteria or preferences (e.g., "I care about AI news")
- Authentication tokens for third-party services

### 4. What's the flow architecture?
- How many nodes and what types? (script nodes for data fetching, agent nodes for LLM processing, condition nodes for branching)
- Is parallel execution needed?
- Does it need tools (agent-invoked scripts) or just canvas scripts?

### 5. How will it be triggered?
- On-demand via chat UI?
- Scheduled (external cron job hitting the agent endpoint)?
- Webhook from another service?

**Gather all prerequisites before building.** Missing an API key or access credential mid-build wastes time and creates half-finished flows.

---

## Project Structure

A Keen flow project has this structure:

```
project-name/
├── src/
│   ├── flows/
│   │   ├── {FlowName}/              # Split format folder (USE THIS)
│   │   │   ├── positions.json       # Node positions and viewport
│   │   │   ├── instructions.json    # Graph structure (nodes + edges)
│   │   │   └── node-settings.json   # Settings for non-agent nodes
│   │   └── {FlowName}.flow.json     # Monolithic file (DO NOT READ)
│   │
│   ├── scripts/                     # Canvas scripts (run by scriptNode_ nodes)
│   │   ├── {script-name}.js
│   │   └── tools/                   # Agent-invoked tool scripts (called via SYSTEM CALL)
│   │       └── {tool-name}.js
│   │
│   └── agents/
│       └── {AgentName}/
│           ├── settings.json        # LLM config, file paths, special rules
│           ├── 00-system.md         # System prompt
│           ├── 01-user.md           # User prompt template
│           └── 02-assistant.md      # Assistant response (optional)
├── Agent.md                         # This file
├── keen.json                        # Project configuration
├── keen-tools.json                  # Tool definitions
└── package.json
```

## Split Format Files

### 1. positions.json (For Moving Nodes)

This is the simplest file. Use it when you need to:
- Move nodes on the canvas
- Change viewport position/zoom
- Check node locations

**Structure:**
```json
{
  "$schema": "keen-flow-positions-v1",
  "viewport": {
    "x": 71.25,
    "y": 59.38,
    "zoom": 0.51
  },
  "nodes": {
    "startNode_{id}": {
      "x": 450,
      "y": 50
    },
    "agentNode_broadcaster__receiver_{id}": {
      "x": 416,
      "y": 312
    },
    "endNode_{id}": {
      "x": 500,
      "y": 623
    }
  }
}
```

**To move a node:** Simply change the `x` and `y` values.

### 2. instructions.json (For Graph Structure)

Contains the flow's logical structure: what nodes exist and how they connect.

**Structure:**
```json
{
  "$schema": "keen-flow-instructions-v1",
  "flowId": "{FlowName}",
  "flowLabel": "{FlowName}",
  "nodes": [
    {
      "id": "startNode_{id}",
      "type": "startNode_",
      "label": "Start"
    },
    {
      "id": "agentNode_broadcaster__receiver_{id}",
      "type": "agentNode_broadcaster__receiver_",
      "agentRef": "{AgentName}"
    },
    {
      "id": "endNode_{id}",
      "type": "endNode_"
    }
  ],
  "edges": [
    {
      "source": "startNode_{id}",
      "target": "agentNode_broadcaster__receiver_{id}",
      "sourceHandle": "NEXT_1",
      "targetHandle": "IN"
    },
    {
      "source": "agentNode_broadcaster__receiver_{id}",
      "target": "endNode_{id}",
      "sourceHandle": "NEXT_1",
      "targetHandle": "IN"
    }
  ]
}
```

**Node ID Format:** Each node needs a unique ID. The UI generates opaque IDs like `startNode_T8AMwU...` (containing alphanumeric characters, hyphens, and underscores). Human-readable IDs (e.g., `startNode_my_start`) also work.

**Node Types (13 total, verified on platform):**

| # | Type | Category | Extra Fields | Description |
|---|------|----------|-------------|-------------|
| 1 | `startNode_` | Flow control | `label` (required) | Flow entry point. **Must have a `label` field** matching the Admin Panel's "Start Node" value (e.g., `"label": "Start"`). Without this, the engine cannot find the entry point and the flow will fail. |
| 2 | `endNode_` | Flow control | — | Flow exit point |
| 3 | `agentNode_broadcaster__receiver_` | Agent | `agentRef` | LLM agent node. **This is the only agent node type that works.** |
| 4 | `scriptNode_` | Logic | `settingsRef` | JavaScript execution |
| 5 | `conditionNode_` | Logic | `settingsRef` | Conditional branching (TRUE/FALSE handles) |
| 6 | `assignmentNode_` | Logic | `settingsRef` | Set dictionary values |
| 7 | `loopNode_` | Logic | `settingsRef` | Loop/iteration |
| 8 | `runFlowNode_` | Flow control | `settingsRef` | Runs another flow and returns |
| 9 | `jumpFlowNode_` | Flow control | `settingsRef` | Jumps to another flow |
| 10 | `groupNode_` | Visual | — | Visual grouping container for organizing nodes |
| 11 | `parallelInNode_` | Parallel | `settingsRef` | Parallel execution entry point |
| 12 | `parallelFlowNode_` | Parallel | `settingsRef` | Parallel flow execution |
| 13 | `joinNode_` | Parallel | — | Joins parallel execution branches back together |

**Deprecated/removed node types (do NOT use):**
- `agentNode_` — broken, does not render
- `agentNode_broadcaster_` — broken, does not render
- `agentNode_receiver_` — broken, does not render
- `displayNode_` — removed from platform
- `setDictionaryNode_` — replaced by `assignmentNode_`

**Edge Handles:**
- `NEXT_1`, `NEXT_2`, etc. - Output handles
- `IN` - Input handle
- For condition nodes: `TRUE`, `FALSE` output handles

### 3. node-settings.json (For Non-Agent Node Settings)

Contains settings for nodes that have a `settingsRef` (script, condition, assignment, loop, runFlow, jumpFlow, parallelIn, parallelFlow nodes).

**Note (observed behavior):** When nodes are first dropped from the UI, their entries in node-settings.json may be empty. Settings appear to be populated when the user edits them in the canvas. When creating nodes programmatically, you should add the settings entries yourself.

**Structure:**
```json
{
  "$schema": "keen-node-settings-v1",
  "nodes": {
    "scriptNode_{id}": {
      "value": "dictionary.result = dictionary.input.toUpperCase();",
      "description": "Converts input to uppercase"
    },
    "conditionNode_{id}": {
      "value": "dictionary.count > 5",
      "description": "Check if count exceeds threshold"
    }
  }
}
```

### 4. Agent Folders (For LLM Configuration)

Located in `src/agents/{AgentName}/`

**settings.json:**
```json
{
  "agentName": "{AgentName}",
  "llm": {
    "company": "google",
    "model": "gemini-2.5-flash",
    "modelId": 4913,
    "parameters": {
      "temperature": 0.8,
      "top_p": 0.8,
      "maxTokens": 65536
    }
  },
  "filePaths": [],
  "specialRules": []
}
```

**Prompt files** are markdown files named `{index}-{role}.md`:
- `00-system.md` - System prompt
- `01-user.md` - User prompt template
- `02-assistant.md` - Assistant response template (if needed)

## Common Operations

### Move a Node

1. Read `src/flows/{FlowName}/positions.json`
2. Update the `x` and `y` values for the target node
3. Save the file

**Example: Move agent node to center**
```json
"agentNode_broadcaster__receiver_{id}": {
  "x": 500,
  "y": 300
}
```

### Add a New Edge

1. Read `src/flows/{FlowName}/instructions.json`
2. Add new edge object to the `edges` array:
```json
{
  "source": "sourceNodeId",
  "target": "targetNodeId",
  "sourceHandle": "NEXT_1",
  "targetHandle": "IN"
}
```

### Update Agent Prompt

1. Navigate to `src/agents/{AgentName}/`
2. Edit the relevant markdown file (e.g., `00-system.md`)
3. Save the file

### Change LLM Model

1. Read `src/agents/{AgentName}/settings.json`
2. Update the `llm` object:
```json
"llm": {
  "company": "openai",
  "model": "gpt-4.1-2025-04-14",
  "parameters": {
    "temperature": 0.7
  }
}
```

### Add a New Node

1. Read `src/flows/{FlowName}/instructions.json`
2. Add node to `nodes` array with a unique ID (e.g., `{nodeType}_{uniqueSuffix}`)
3. Add position to `positions.json`
4. If agent node (`agentNode_broadcaster__receiver_`): create agent folder in `src/agents/` with `settings.json` and `00-system.md`
5. If node has `settingsRef`: add entry to `node-settings.json`
6. Connect with edges

**Note on agent nodes from the UI (observed behavior):** When you drop an agent node from the canvas UI, the platform has been observed to auto-create a generic agent folder (e.g., `src/agents/Agent_agentNod/`) with a default `settings.json` and no prompt files. You should update the `agentRef` and create a proper agent folder with prompts.

## Why Split Format?

Compare these two approaches for the same flow:

**Monolithic .flow.json:** ~12,000 characters, single line, includes all React Flow internals
```json
{"nodes":[{"id":"startNode_default_start","type":"startNode_","position":{"x":456.1111620973372,"y":2.485344325105318},"data":{"label":"startNode_","nodeIDs":[],"settings":{"label":"Start"}}},...
```

**Split positions.json:** ~22 lines, clean, focused
```json
{
  "$schema": "keen-flow-positions-v1",
  "viewport": { "x": 71.25, "y": 59.38, "zoom": 0.51 },
  "nodes": {
    "startNode_{id}": { "x": 450, "y": 50 },
    "agentNode_broadcaster__receiver_{id}": { "x": 416, "y": 312 }
  }
}
```

Split format is:
- **Smaller** - Each file is ~20-100 lines instead of thousands
- **Focused** - Each file has one purpose
- **Readable** - Properly formatted JSON with line breaks
- **Efficient** - Only read what you need

**Important:** `src/flows/` is the source of truth. The `dist/` directory contains built output (`dist/flows/*.flow.js`) which is generated by the builder. Always edit in `src/flows/`, never in `dist/`.

**You must build and deploy for changes to take effect.** Editing `src/` files alone does not update the running server. Each project has a deploy script in `package.json` that invokes `keen-builder` with a token and space ID. The space and its deploy credentials are configured through the Admin Panel. Running the deploy script will:
1. Compile split format files into `dist/flows/{FlowName}.flow.js`
2. Copy scripts to `dist/scripts/`
3. Upload the project to the configured Keen server space

If a flow file is missing from `dist/flows/` after building, the flow likely has a compilation error (e.g., missing `label` on startNode, invalid node references). Check the builder output for `[ERROR]` messages.

## Quick Reference

| Task | File to Edit |
|------|--------------|
| Move node | `positions.json` |
| Change viewport | `positions.json` |
| Add/remove node | `instructions.json` + `positions.json` |
| Connect nodes | `instructions.json` |
| Edit agent prompt | `agents/{Name}/*.md` |
| Change LLM settings | `agents/{Name}/settings.json` |
| Edit script/condition/assignment/loop | `node-settings.json` |
| Edit runFlow/jumpFlow/parallel settings | `node-settings.json` |
| Add/edit agent tool | `keen-tools.json` + `src/scripts/tools/*.js` |
| Add/edit canvas script | `node-settings.json` + `src/scripts/*.js` |
| Register agent for execution | Admin Panel (not keen.json) |

## File Reading Priority

When investigating a flow:

1. **First**: Read `instructions.json` to understand the graph structure
2. **If needed**: Read `positions.json` for layout information
3. **For agent details**: Read `agents/{AgentName}/settings.json` and prompts
4. **For scripts/conditions**: Read `node-settings.json`
5. **For agent tools**: Read `keen-tools.json` and `src/scripts/tools/*.js`
6. **For canvas scripts**: Read `src/scripts/*.js` (root level)
7. **NEVER**: Read the `.flow.json` file

---

# Advanced Concepts

## Scripts and the Dictionary Pattern

Scripts in Keen flows use a shared `dictionary` object to pass data between nodes.

### Reading and Writing Dictionary Values

```javascript
// Set values (available to downstream nodes)
dictionary.email = emailContent;
dictionary.isEmailValid = true;
dictionary.labelName = 'ai_success';

// Read values (from upstream nodes)
const threadId = dictionary.threadId;
const cargo = dictionary.cargo;
```

### Common Dictionary Keys

| Key | Purpose |
|-----|---------|
| `promptMessage` | Engine-managed object containing session credentials, user input, and other context. **See warning below.** |
| `promptMessage.content` | Input payload (JSON-stringified). This is the field you should read/write for passing data to agent nodes. |
| `isEmailValid` | Boolean validation flag for condition nodes |
| `labelName` | Status label (e.g., 'ai_success', 'ai_skip') |
| `emailContent` | Extracted/processed content |
| `threadId` | External reference IDs |
| `response` | Tool script output (returned to agent) |

### CRITICAL: Never overwrite `dictionary.promptMessage`

The `dictionary.promptMessage` object contains engine-managed data including `userSessionCredentials` and other context required for flow execution. **If you replace the entire object, the flow will crash** with an error like:

```
Cannot destructure property 'userID' of 'userSessionCredentials' as it is undefined.
```

**WRONG — destroys session context:**
```javascript
dictionary.promptMessage = { content: 'my data' };
```

**CORRECT — only update the content field:**
```javascript
if (!dictionary.promptMessage) {
    dictionary.promptMessage = {};
}
dictionary.promptMessage.content = JSON.stringify(myData);
```

This applies to any engine-managed dictionary key. As a general rule: **update individual properties on existing dictionary objects rather than replacing the entire object.**

### Script in node-settings.json

The `value` field for a `scriptNode_` is a **filename reference** (relative to `src/scripts/`), not inline code. The engine resolves it to `{SCRIPT_ABS_PATH}/{value}` and executes the file.

```json
{
  "$schema": "keen-node-settings-v1",
  "nodes": {
    "scriptNode_{id}": {
      "value": "fetch-youtube-videos.js",
      "description": "Fetch latest videos from YouTube channels"
    }
  }
}
```

---

## Condition Nodes (Branching Logic)

Condition nodes check dictionary values to determine flow path.

### Setting Up a Condition

1. **Script sets the condition:**
```javascript
dictionary.isEmailValid = true;  // or false
```

2. **Condition node in instructions.json:**
```json
{
  "id": "conditionNode_xyz789",
  "type": "conditionNode_",
  "settingsRef": "conditionNode_xyz789"
}
```

3. **Condition expression in node-settings.json:**
```json
{
  "conditionNode_xyz789": {
    "value": "dictionary.isEmailValid",
    "description": "Check if email passed validation"
  }
}
```

### Edge Handles for Conditions

```json
{
  "source": "conditionNode_xyz789",
  "target": "nextNode_success",
  "sourceHandle": "TRUE",
  "targetHandle": "IN"
},
{
  "source": "conditionNode_xyz789",
  "target": "skipNode",
  "sourceHandle": "FALSE",
  "targetHandle": "IN"
}
```

---

## Tool/KPI Calls in Scripts

Scripts can call external APIs (tools/KPIs) via REST:

```javascript
const response = await fetch(
    `https://api.example.com/tools/${toolName}`,
    {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }
);
const data = await response.json();
dictionary.toolResult = data;
```

### Tools are defined in keen-tools.json

```json
[
    {
        "name": "Calculate",
        "type": "script",
        "entry": "calculate.js"
    }
]
```

---

# Scripts vs Tools

There are two distinct types of JavaScript files in a Keen project. They live in different locations and serve different purposes:

| | Canvas Scripts | Agent Tools |
|---|---|---|
| **Purpose** | Run by `scriptNode_` nodes on the flow canvas | Invoked by agents via `<SYSTEM CALL>` during conversation |
| **Location** | `src/scripts/` (root level) | `src/scripts/tools/` (subfolder) |
| **Configured in** | `node-settings.json` (via `settingsRef`) | `keen-tools.json` |
| **Triggered by** | Flow execution reaching a `scriptNode_` | Agent outputting a `<SYSTEM CALL>` block |
| **Read params from** | `dictionary.{key}` directly | `dictionary.TOOL_CONTEXT.{key}` |
| **Write response to** | `dictionary.{key}` directly | `dictionary.response` |
| **Example** | `src/scripts/debux.js` | `src/scripts/tools/weather-tool.js` |

**Do not mix these up.** Canvas scripts go in `src/scripts/`, tool scripts go in `src/scripts/tools/`.

---

# Tools System (Agent-Invoked Tools)

## Overview

Tools allow agents to execute JavaScript code during a conversation. The agent outputs a special `<SYSTEM CALL>` block, the engine intercepts it, runs the corresponding script, and returns the result to the agent.

**Tool scripts must be placed in `src/scripts/tools/`**, not in `src/scripts/` directly.

## Tool Configuration: keen-tools.json

Tools are defined in `keen-tools.json` at the project root.

**Correct Format:**
```json
[
    {
        "name": "Weather Tool",
        "type": "script",
        "entry": "tools/weather-tool.js"
    }
]
```

**Required Fields:**

| Field | Description | Example |
|-------|-------------|---------|
| `name` | Tool name (used in SYSTEM CALL) | `"Weather Tool"` |
| `type` | Must be `"script"` for JS tools | `"script"` |
| `entry` | Path relative to `src/scripts/` | `"tools/weather-tool.js"` |

**IMPORTANT:**
- Do NOT use `"script"` as the key — use `"entry"` for the filename.
- The `entry` path is relative to `src/scripts/`, so tools use the `tools/` prefix.

## Tool Script Files: src/scripts/tools/*.js

Tool scripts must export an async `exec()` function.

**CRITICAL: In tool scripts, parameters from the agent's `<SYSTEM CALL>` are available at `dictionary.TOOL_CONTEXT`, NOT directly on `dictionary`.** The engine places all parsed SYSTEM CALL parameters into `dictionary.TOOL_CONTEXT` before executing the script.

| What you want | Correct | WRONG |
|---|---|---|
| Read a parameter from agent | `dictionary.TOOL_CONTEXT.city` | ~~`dictionary.city`~~ |
| Write the response back | `dictionary.response` | — |

Note: Writing the response back is still `dictionary.response` (not `dictionary.TOOL_CONTEXT.response`).

**Basic Structure:**
```javascript
export async function exec() {
    // Read parameters from TOOL_CONTEXT (where the engine puts SYSTEM CALL params)
    const param = dictionary.TOOL_CONTEXT.paramName;

    // Do something
    const result = 'Hello!';

    // Write response back to dictionary (NOT TOOL_CONTEXT)
    dictionary.response = result;
}
```

**Example - Weather Tool (tools/weather-tool.js):**
```javascript
export async function exec() {
    const city = dictionary.TOOL_CONTEXT.city;

    if (!city) {
        dictionary.response = 'Error: No city provided.';
        return;
    }

    const geoRes = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`
    );
    const geoData = await geoRes.json();

    if (!geoData.results || geoData.results.length === 0) {
        dictionary.response = `Error: Could not find location "${city}".`;
        return;
    }

    const { latitude, longitude, name, country } = geoData.results[0];

    const weatherRes = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&timezone=auto`
    );
    const weatherData = await weatherRes.json();
    const current = weatherData.current;

    dictionary.response = JSON.stringify({
        location: `${name}, ${country}`,
        temperature: `${current.temperature_2m}°C`,
        humidity: `${current.relative_humidity_2m}%`,
        wind_speed: `${current.wind_speed_10m} km/h`,
        weather_code: current.weather_code
    });
}
```

## Agent Prompts for Tool Usage

To enable an agent to use tools, add the SYSTEM CALL format to the system prompt.

**System Prompt Template (00-system.md):**
```markdown
You are an assistant with access to tools.

**When you need to use a tool**, output it between `<SYSTEM CALL>` and `</SYSTEM CALL>` markers using this format:

<SYSTEM CALL>
!*action
use tool
!*tool
[Tool Name]
!*[parameter1]
[Value1]
!*[parameter2]
[Value2]
</SYSTEM CALL>

**Important:**
- Place `<SYSTEM CALL>` and `</SYSTEM CALL>` at the **start of the line**.
- Each `!*` marker must be at the **start of the line**.
- Do not indent the markers.
- Do not include any extra text inside the `<SYSTEM CALL>` block.

**Available Tools:**

1. **Test Tool**
   - **Description**: A test tool that returns a confirmation message.
   - **Usage**:

   <SYSTEM CALL>
   !*action
   use tool
   !*tool
   Test Tool
   !*message
   Your message here
   </SYSTEM CALL>
```

## How Tool Calling Works

1. Agent outputs a `<SYSTEM CALL>` block in its response
2. Engine parses the block and extracts:
   - `tool` - The tool name (must match `name` in keen-tools.json)
   - Parameters (e.g., `city`, `expression`)
3. Engine looks up the tool in keen-tools.json
4. Engine places all parsed parameters into `dictionary.TOOL_CONTEXT`
5. Engine loads and executes the script from `src/scripts/{entry}`
6. Script reads parameters from `dictionary.TOOL_CONTEXT.{paramName}`
7. Script writes result to `dictionary.response`
8. Engine cleans up `TOOL_CONTEXT` and returns the response to the agent as a system message

## Adding a New Tool

### Step 1: Create the Script

Create `src/scripts/tools/my-tool.js`:
```javascript
export async function exec() {
    const input = dictionary.TOOL_CONTEXT.input;

    // Your logic here
    const result = `Processed: ${input}`;

    dictionary.response = result;
}
```

### Step 2: Register in keen-tools.json

Add to `keen-tools.json`:
```json
{
    "name": "My Tool",
    "type": "script",
    "entry": "tools/my-tool.js"
}
```

### Step 3: Document in Agent Prompt

Add to the agent's `00-system.md`:
```markdown
2. **My Tool**
   - **Description**: Processes input and returns result.
   - **Usage**:

   <SYSTEM CALL>
   !*action
   use tool
   !*tool
   My Tool
   !*input
   The input to process
   </SYSTEM CALL>
```

---

## Streaming (Real-time UI Updates)

Agents can stream status updates back to the user interface:

```javascript
// Start agent session
writeAgentStart(mainSessionId, sessionId, 'AgentName', subject);

// Stream progress updates
writeAgentStream(sessionID, 'Processing...');
writeAgentStream(sessionID, 'Found 3 results');

// End session
writeAgentEnd(sessionId, 'completed');
```

### Session ID Structure
```javascript
sessionID: `${mainSessionId}_${Date.now()}_${Math.random()}`
```

---

## Parallel Flow Execution

Scripts can spawn multiple flow instances in parallel:

```javascript
// Parallel execution of multiple flows
const flowPromises = items.map(item =>
    flow.run('FlowName-EntryAgent', {
        promptMessage: { content: JSON.stringify(item) }
    })
);
await Promise.all(flowPromises);
```

---

## Agent Communication Tags

Agents use special tags for structured output that scripts can parse:

```xml
<AgentName>
  Structured output here
</AgentName>

<FAIL>Error message</FAIL>
<SUCCESS></SUCCESS>
<PENDING>Need more information</PENDING>
```

### Parsing in Scripts
```javascript
if (agentOutput.includes('<FAIL>')) {
    dictionary.isEmailValid = false;
}
```

---

## Error Recovery Pattern

Errors should set validation flags rather than crashing:

```javascript
try {
    // API call or processing
    const result = await fetch(...);
    dictionary.result = result;
} catch (error) {
    dictionary.isEmailValid = false;
    dictionary.errorMessage = error.message;
    writeAgentStream(sessionID, `Error: ${error.message}`);
}
```

All paths should eventually reach `endNode` - no orphaned flows.

---

## LLM Model Selection Guidelines

| Task Type | Recommended Model |
|-----------|-------------------|
| Complex parsing (addresses, entities) | Gemini 2.5-pro |
| Classification/categorization | GPT-4o |
| Math/validation | GPT-4.1-2025 |
| Natural language generation | GPT-4.1-2025 |
| Simple extraction | Gemini 2.5-flash |

---

## Flow Architecture Patterns

Note: "agent" below refers to `agentNode_broadcaster__receiver_`, the only working agent node type.

### Simple Linear Flow
```
startNode_ → agentNode_broadcaster__receiver_ → endNode_
```

### Branching Flow
```
startNode_ → agentNode_broadcaster__receiver_ → conditionNode_
                                                    ├─ TRUE → scriptNode_ → endNode_
                                                    └─ FALSE → endNode_
```

### Orchestrator Pattern
```
startNode_ → scriptNode_ → endNode_
             (spawns parallel sub-flows)
```

### Multi-Agent Pipeline
```
startNode_ → agent1 → scriptNode_ → conditionNode_
                                        ├─ TRUE → agent2 → agent3 → endNode_
                                        └─ FALSE → endNode_
```
*(agent1, agent2, agent3 are all `agentNode_broadcaster__receiver_` nodes with different `agentRef` values)*

---

## Additional Resources

- **keen.json** - Project configuration (server URL, entry/dist paths)
- **keen-tools.json** - Available tools/KPIs
- **Admin Panel** - Agent registration and routing (`{keen_server}/org/agent/...`)

---

## keen.json Configuration

The `keen.json` file defines minimal project configuration. Agent routing is handled via the **Admin Panel**, not in this file.

```json
{
    "keen_server": "{keen_server_url}",
    "entry": "src",
    "dist": "dist"
}
```

| Field | Description |
|-------|-------------|
| `keen_server` | URL of the Keen server |
| `entry` | Source directory (contains agents, flows, scripts) |
| `dist` | Build output directory |

**Note (observed behavior):** The `agents` array, `agent`, and `start_agent` fields that previously existed in keen.json do not appear to be used in the current platform build. Agent registration is currently done through the Admin Panel.

---

## Agent Registration (Admin Panel)

Agents are registered and configured through the Keen Admin Panel at `{keen_server}/org/agent/...`.

### Admin Panel Fields

| Field | Description | Example |
|-------|-------------|---------|
| **Display Name** | Human-friendly name shown in the UI. Must match the agent folder name in `src/agents/` and the `agentRef` in the flow. | `{AgentName}` |
| **Enabled** | Toggle to turn the agent on/off | On |
| **Template Markup** | Custom prompt markup (optional) | *(empty)* |
| **Start Flow** | The flow file to execute when this agent receives a prompt (matches the flow folder name in `src/flows/`) | `{FlowName}` |
| **Start Node** | The entry node label within the flow | `Start` |

### How It Works (observed behavior)

1. Agent is created in the Admin Panel with a **Display Name**, **Start Flow**, and **Start Node**
2. When a prompt is sent to this agent, the engine loads `{Start Flow}.flow.json` and begins execution at the node labeled `{Start Node}`
3. The agent name must be consistent across: Admin Panel Display Name, `src/agents/{AgentName}/` folder, and `agentRef` in instructions.json

### Example

For an agent named `{AgentName}` using the `{FlowName}` flow:
- **Admin Panel Display Name**: `{AgentName}`
- **Start Flow**: `{FlowName}`
- **Start Node**: `Start`
- **Agent folder**: `src/agents/{AgentName}/`
- **Flow `agentRef`**: `"agentRef": "{AgentName}"` in `src/flows/{FlowName}/instructions.json`
