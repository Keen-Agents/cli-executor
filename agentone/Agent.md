# AI Agent Guide: Working with Keen Flow Projects

## Critical Rule

**NEVER read `.flow.json` files directly.** These are monolithic files that can be 12,000+ characters on a single line. Instead, always use the **split flow format** which breaks down the same information into small, focused files.

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
│   ├── scripts/                     # Scripts folder
│   │   ├── {flow-script}.js         # Flow scripts (called from flow nodes)
│   │   └── tools/                   # Tools subfolder
│   │       └── {tool-name}.js       # Tools (called by agents via SYSTEM CALL)
│   │
│   └── agents/
│       └── {AgentName}/
│           ├── settings.json        # LLM config, file paths, special rules
│           ├── 00-system.md         # System prompt
│           ├── 01-user.md           # User prompt template
│           └── 02-assistant.md      # Assistant response (optional)
├── Agent.md                         # This file
├── keen.json                        # Project configuration
├── keen-tools.json                  # Tool definitions (only for tools/, not flow scripts)
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
    "startNode_default_start": {
      "x": 600,
      "y": 2.49
    },
    "agentNode_default_agent": {
      "x": 460.53,
      "y": 209.05
    },
    "endNode_default_end": {
      "x": 300,
      "y": 550
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
  "flowId": "Project",
  "flowLabel": "Start",
  "nodes": [
    {
      "id": "startNode_default_start",
      "type": "startNode_",
      "label": "Start"
    },
    {
      "id": "agentNode_default_agent",
      "type": "agentNode_broadcaster__receiver_",
      "agentRef": "Agent-jokester",
      "label": "Jokester Agent"
    },
    {
      "id": "endNode_default_end",
      "type": "endNode_"
    }
  ],
  "edges": [
    {
      "source": "startNode_default_start",
      "target": "agentNode_default_agent",
      "sourceHandle": "NEXT_1",
      "targetHandle": "IN"
    },
    {
      "source": "agentNode_default_agent",
      "target": "endNode_default_end",
      "sourceHandle": "NEXT_1",
      "targetHandle": "IN"
    }
  ]
}
```

**Node Types:**
- `startNode_` - Flow entry point
- `endNode_` - Flow exit point
- `agentNode_` - LLM agent (has `agentRef` pointing to agent folder)
- `agentNode_broadcaster_` - Agent that broadcasts messages
- `agentNode_receiver_` - Agent that receives messages
- `agentNode_broadcaster__receiver_` - Agent that does both
- `scriptNode_` - JavaScript execution (has `settingsRef`)
- `conditionNode_` - Conditional branching (has `settingsRef`)
- `runFlowNode_` - Runs another flow (has `settingsRef`)
- `displayNode_` - Display output (has `settingsRef`)
- `setDictionaryNode_` - Set dictionary values (has `settingsRef`)

**Edge Handles:**
- `NEXT_1`, `NEXT_2`, etc. - Output handles
- `IN` - Input handle
- For condition nodes: `TRUE`, `FALSE` output handles

### 3. node-settings.json (For Non-Agent Node Settings)

Contains settings for script nodes, condition nodes, etc.

**Structure:**
```json
{
  "$schema": "keen-node-settings-v1",
  "nodes": {
    "scriptNode_abc123": {
      "value": "return context.input.toUpperCase();",
      "description": "Converts input to uppercase"
    },
    "conditionNode_def456": {
      "value": "context.count > 5",
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
  "agentName": "Agent-jokester",
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
"agentNode_default_agent": {
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
2. Add node to `nodes` array with unique ID
3. Add position to `positions.json`
4. If agent node: create agent folder in `src/agents/`
5. If settings node: add entry to `node-settings.json`
6. Connect with edges

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
    "startNode_default_start": { "x": 600, "y": 2.49 },
    "agentNode_default_agent": { "x": 460.53, "y": 209.05 }
  }
}
```

Split format is:
- **Smaller** - Each file is ~20-100 lines instead of thousands
- **Focused** - Each file has one purpose
- **Readable** - Properly formatted JSON with line breaks
- **Efficient** - Only read what you need

## Quick Reference

| Task | File to Edit |
|------|--------------|
| Move node | `positions.json` |
| Change viewport | `positions.json` |
| Add/remove node | `instructions.json` + `positions.json` |
| Connect nodes | `instructions.json` |
| Edit agent prompt | `agents/{Name}/*.md` |
| Change LLM settings | `agents/{Name}/settings.json` |
| Edit script/condition | `node-settings.json` |
| Add/edit tool | `keen-tools.json` + `src/scripts/tools/*.js` |
| Add/edit flow script | `src/scripts/*.js` (NOT in tools folder) |

---

## Scripts vs Tools: Critical Distinction

### The Core Principle: Cognitive vs Deterministic Work

**Cognitive Work** = Tasks that require AI reasoning, judgment, or analysis
→ Use **Agents with Tools**

**Deterministic Work** = Tasks that execute the same way every time, 100% predictable
→ Use **Flow Scripts**

### Folder Structure

```
src/scripts/
├── check-drive-download-files-for-processing.js   ← FLOW SCRIPT
├── attach-file-id-and-call-agent.js               ← FLOW SCRIPT
├── unzip-extracted-files.js                       ← FLOW SCRIPT
│
└── tools/                                         ← TOOLS FOLDER
    ├── pdf-extract-multiple.js                    ← TOOL (agent-callable)
    ├── gdrive-upload-file.js                      ← TOOL (agent-callable)
    └── ... (all tools here)
```

### Flow Scripts (`src/scripts/*.js`)

- **Location:** Directly in `src/scripts/` (NOT in tools subfolder)
- **Called by:** Flow nodes (scriptNode_ type)
- **NOT registered** in `keen-tools.json`
- **Purpose:** Orchestration, data transformation, deterministic operations

**Examples:**
- Download file from GDrive
- Unzip a file
- Call another flow
- Transform data between nodes

**When to use:**
- The operation is always the same (no AI decision needed)
- It's a step in a pipeline that always executes
- It's orchestration logic

### Tools (`src/scripts/tools/*.js`)

- **Location:** In `src/scripts/tools/` subfolder
- **Called by:** Agents via `<SYSTEM CALL>` blocks
- **MUST be registered** in `keen-tools.json`
- **Purpose:** Operations that agents choose to invoke

**Examples:**
- PDF Extract Multiple Ranges (agent decides page ranges)
- GDrive Upload File (agent decides what to upload)
- Read File (agent decides which file to read)

**When to use:**
- The agent needs to decide IF and HOW to use it
- Parameters are determined by AI reasoning
- It's a capability the agent can choose to invoke

### Decision Flowchart

```
Does this operation require AI judgment?
    │
    ├─ YES → Make it a TOOL in src/scripts/tools/
    │        Register in keen-tools.json
    │        Agent calls via <SYSTEM CALL>
    │
    └─ NO → Make it a FLOW SCRIPT in src/scripts/
            Called from flow node
            No registration needed
```

### Real Example: PDF Processing Workflow

```
┌─────────────────────────────────────────────────────────────────────┐
│ FLOW SCRIPTS (Deterministic)              TOOLS (Cognitive)         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│ 1. check-drive-download-files-for-processing.js                     │
│    → Always: List folder, download first PDF                        │
│                                                                      │
│ 2. attach-file-id-and-call-agent.js                                 │
│    → Always: Attach file, call PDFExtractor agent                   │
│                                                                      │
│         ┌──────────────────────────────────────┐                    │
│         │ PDFExtractor Agent (Cognitive)        │                    │
│         │ - Analyzes document structure         │                    │
│         │ - Decides how to split               │ ←─── Uses TOOL:    │
│         │ - Determines page ranges              │      "PDF Extract  │
│         │ - Classifies document types           │       Multiple     │
│         └──────────────────────────────────────┘       Ranges"      │
│                                                                      │
│ 3. unzip-extracted-files.js                                         │
│    → Always: Unzip the output ZIP file                              │
│                                                                      │
│ 4. upload-to-gdrive.js                                              │
│    → Always: Upload extracted files to GDrive                       │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Insight

The **agent does cognitive work** - analyzing the PDF, understanding document boundaries, deciding page ranges. But everything before and after the agent is **deterministic** - downloading, unzipping, uploading. These deterministic steps should be flow scripts, not tools.

## File Reading Priority

When investigating a flow:

1. **First**: Read `instructions.json` to understand the graph structure
2. **If needed**: Read `positions.json` for layout information
3. **For agent details**: Read `agents/{AgentName}/settings.json` and prompts
4. **For scripts/conditions**: Read `node-settings.json`
5. **For tools**: Read `keen-tools.json` and `src/scripts/*.js`
6. **NEVER**: Read the `.flow.json` file

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
| `promptMessage.content` | Input payload (JSON-stringified) |
| `isEmailValid` | Boolean validation flag for condition nodes |
| `labelName` | Status label (e.g., 'ai_success', 'ai_skip') |
| `emailContent` | Extracted/processed content |
| `threadId` | External reference IDs |
| `response` | Tool script output (returned to agent) |

### Script in node-settings.json

```json
{
  "$schema": "keen-node-settings-v1",
  "nodes": {
    "scriptNode_abc123": {
      "value": "dictionary.result = dictionary.input.toUpperCase(); return dictionary.result;",
      "description": "Uppercase converter"
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

# Tools System (Agent-Invoked Tools)

## Overview

Tools allow agents to execute JavaScript code during a conversation. The agent outputs a special `<SYSTEM CALL>` block, the engine intercepts it, runs the corresponding script, and returns the result to the agent.

## Tool Configuration: keen-tools.json

Tools are defined in `keen-tools.json` at the project root.

**Correct Format:**
```json
[
    {
        "name": "Test Tool",
        "type": "script",
        "entry": "test.js"
    },
    {
        "name": "Calculate",
        "type": "script",
        "entry": "calculate.js"
    }
]
```

**Required Fields:**

| Field | Description | Example |
|-------|-------------|---------|
| `name` | Tool name (used in SYSTEM CALL) | `"Test Tool"` |
| `type` | Must be `"script"` for JS tools | `"script"` |
| `entry` | Script filename in `src/scripts/` | `"test.js"` |

**IMPORTANT:** Do NOT use `"script"` as the key - use `"entry"` for the filename.

## Tool Script Files: src/scripts/tools/*.js

Tool scripts must export an async `exec()` function. They are located in the `tools/` subfolder.

**Basic Structure:**
```javascript
export async function exec() {
    // Read parameters from dictionary
    const param = dictionary.paramName;

    // Do something
    const result = 'Hello!';

    // Write response back to dictionary
    dictionary.response = result;
}
```

**Example - Simple Test Tool (test.js):**
```javascript
export async function exec() {
    const message = dictionary.message;

    // Default message if none provided
    const inputMessage = message || 'No message provided';

    // Return a response confirming the tool was called
    dictionary.response = 'Test tool executed successfully! Tool calling is working.';
}
```

**Example - API Call Tool (calculate.js):**
```javascript
export async function exec() {
    const expression = dictionary.expression;

    if (!expression) {
        dictionary.response = {
            error: 'Missing expression parameter'
        }
        return;
    }

    const response = await fetch('https://api.example.com/calculate', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ expression })
    });
    const result = await response.json();

    dictionary.response = result;
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
   - Parameters (e.g., `message`, `expression`)
3. Engine looks up the tool in keen-tools.json
4. Engine loads and executes the script from `src/scripts/{entry}`
5. Parameters are passed via `dictionary.{paramName}`
6. Script writes result to `dictionary.response`
7. Engine returns the response to the agent as a system message

## Adding a New Tool

### Step 1: Create the Script

Create `src/scripts/my-tool.js`:
```javascript
export async function exec() {
    const input = dictionary.input;

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
    "entry": "my-tool.js"
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

### Simple Linear Flow
```
startNode → agentNode → endNode
```

### Branching Flow
```
startNode → agentNode → conditionNode
                            ├─ TRUE → processNode → endNode
                            └─ FALSE → skipNode → endNode
```

### Orchestrator Pattern
```
startNode → orchestratorScript → endNode
            (spawns parallel sub-flows)
```

### Multi-Agent Pipeline
```
startNode → Agent1 → script1 → conditionNode
                                   ├─ TRUE → Agent2 → Agent3 → endNode
                                   └─ FALSE → endNode
```

---

## Additional Resources

- **learning-journal.md** - Detailed exploration notes from complex projects
- **keen.json** - Project configuration (agents, deployment URL)
- **keen-tools.json** - Available tools/KPIs

---

## keen.json Configuration (Multi-Agent Format)

The `keen.json` file defines project configuration and available agents.

### New Format (Recommended)

```json
{
    "project_name": "pdf-agent",
    "keen_server": "http://localhost:3030",
    "entry": "src",
    "dist": "dist",
    "agents": [
        {
            "id": "pdf-attacher",
            "name": "PDFAttachToSFAgent",
            "entry_flow": "SFAttacher",
            "entry_node": "Start"
        },
        {
            "id": "pdf-extractor",
            "name": "PDFExtractorAgent",
            "entry_flow": "PDFExtractor",
            "entry_node": "Start"
        },
        {
            "id": "deal-recognizer",
            "name": "DealRecognitionAgent",
            "entry_flow": "DealRecognizer",
            "entry_node": "Start"
        }
    ]
}
```

### Agent Configuration Fields

| Field | Description | Example |
|-------|-------------|---------|
| `id` | Unique identifier used in Chat UI Controller field | `"pdf-attacher"` |
| `name` | The actual agent name (matches `agentRef` in flow and folder in `src/agents/`) | `"PDFAttachToSFAgent"` |
| `entry_flow` | Flow file name (without `.flow.js`) | `"SFAttacher"` |
| `entry_node` | Start node label within the flow | `"Start"` |

### How It Works

1. **Chat UI** sends the `id` (e.g., `"pdf-attacher"`) as the Controller
2. **Engine** looks up the agent config by `id`
3. **Engine** loads `{entry_flow}.flow.js` and starts at the node labeled `{entry_node}`
4. **Engine** returns the output from agent named `{name}`

---

## Chat UI Configuration

When setting up an agent in the Chat UI:

| Field | Value | Description |
|-------|-------|-------------|
| **Agent Name** | `PDFAttachToSFAgent` | Display name (can be anything) |
| **Project** | `pdf-agent` | Must match `project_name` in keen.json |
| **Controller** | `pdf-attacher` | Must match an `id` from the `agents` array |

### Example Setup

For the PDF Attacher agent:
- **Project**: `pdf-agent`
- **Controller**: `pdf-attacher`

For the PDF Extractor agent:
- **Project**: `pdf-agent`
- **Controller**: `pdf-extractor`

For the Deal Recognizer agent:
- **Project**: `pdf-agent`
- **Controller**: `deal-recognizer`

---

## Legacy Format (Deprecated)

The old format is still supported for backwards compatibility but not recommended for new projects:

```json
{
    "project_name": "my-project",
    "agent": "AgentName",
    "start_agent": "FlowName-StartNodeLabel",
    "keen_server": "http://localhost:3030",
    "entry": "src",
    "dist": "dist"
}
```

**Problems with legacy format:**
- `agent` field name is confusing (it's actually the output agent, not the entry)
- `start_agent` combines flow name and node label with a hyphen (confusing)
- Only supports a single agent per project

**Migration:** Replace `agent` and `start_agent` with the `agents` array.

---

# File Handling in Cloud Environment

## Shared Volumes (Docker ↔ Host)

The engine runs in Docker with volume mounts that map host paths to container paths.

### Local Development Configuration

**Compose file:** `sandbox-local-development-with-database.yaml`

```yaml
volumes:
    - C:\Users\{username}\Documents\KeenAgentsStorage\projects:/app/projects
    - C:\Users\{username}\Documents\KeenAgentsStorage\uploads:/app/uploads
    - C:\Users\{username}\Documents\KeenAgentsStorage\logs:/app/logs
```

### Cloud/Production Configuration

**Compose file:** `prod-cloud-ready-with-chat-ui.yaml`

```yaml
volumes:
    - /opt/keen-storage/projects:/app/projects
    - /opt/keen-storage/uploads:/app/uploads
    - /opt/keen-storage/logs:/app/logs
```

### Path Mapping Reference

| Environment | Host Path | Container Path |
|-------------|-----------|----------------|
| Local (Windows) | `C:/Users/.../KeenAgentsStorage/uploads` | `/app/uploads` |
| Cloud (Linux) | `/opt/keen-storage/uploads` | `/app/uploads` |

---

## Attaching Files to Agent Messages

When calling an agent flow, you can attach files that will be automatically uploaded to Gemini for the agent to read.

### Using filePaths in promptMessage

```javascript
const promptMessage = {
    role: 'user',
    content: 'Process the attached PDF file...',

    // Attach files - Gemini will read them automatically
    filePaths: [
        { path: '/app/uploads/session123/document.pdf' }
    ],

    userSessionCredentials: {
        sessionID: `${parentSessionID}_${Date.now()}`,
        userID: parentUserID,
    },
    agentChat: false
};

await flow.run('PDFExtractor-Start', { promptMessage });
```

### Key Points

- Use container paths (e.g., `/app/uploads/...`) in `filePaths`
- The engine will upload the file to Gemini's File API
- The agent sees the file content directly - no need for a "Read File" tool
- Works with PDFs, images, and other supported file types

---

## Calling Flows from Scripts

Scripts can spawn sub-flows using `flow.run()`.

### Basic Usage

```javascript
import flow from 'system/flow';

export async function exec() {
    // Call another flow with a prompt message
    const result = await flow.run('agent-id', {
        promptMessage: {
            role: 'user',
            content: 'Your message here',
            userSessionCredentials: {
                sessionID: `${dictionary.promptMessage.userSessionCredentials.sessionID}_${Date.now()}`,
                userID: dictionary.promptMessage.userSessionCredentials.userID,
            },
            agentChat: false
        }
    });

    dictionary.flowResult = result;
}
```

### IMPORTANT: Use Agent ID, Not Flow Path

**`flow.run()` must use the agent `id` from `keen.json`, NOT the flow path format.**

### IMPORTANT: flow.run() Returns Dictionary Directly

**`flow.run()` returns the dictionary object directly, NOT wrapped in `{dictionary: ...}`.**

```javascript
const result = await flow.run('single-file-pipeline', { promptMessage });

// CORRECT - access properties directly on result
const pipelineResult = result?.pipelineResult;  // ✅

// WRONG - there is no .dictionary wrapper
const pipelineResult = result?.dictionary?.pipelineResult;  // ❌ undefined!
```

The `result` object IS the dictionary. Any values set via `dictionary.someKey = value` in the sub-flow are available as `result.someKey` in the parent.

### IMPORTANT: Script-Only Flows Must Set Output Key

For flows that have **no agent (LLM) node** - only script nodes - you must manually set the output using the exact `name` from `keen.json`:

```javascript
// keen.json has: { "id": "batch-orchestrator", "name": "BatchOrchestratorProcessor", ... }

// In your script, set output using the EXACT name:
dictionary["BatchOrchestratorProcessor"] = yourOutputData;
```

**Why?** The engine looks for output at `dictionary[name]` where `name` is from keen.json. Agent nodes populate this automatically, but script nodes don't. Without this, you get: `"error": "No output from agent: YourAgentName"`

### IMPORTANT: writeOut() vs writeThinking() for UI Output

Scripts have two functions for outputting text, and they display differently in the Chat UI:

| Function | Where it appears | Use for |
|----------|------------------|---------|
| `writeOut(message)` | **Chat area** (main conversation) | Final reports, user-facing messages |
| `writeThinking(message)` | **Thinking box** (collapsible) | Progress logs, debug info, step details |

```javascript
// Goes to main chat area - user sees this directly
writeOut("## Final Report\n\nProcessed 5 files successfully.");

// Goes to collapsible thinking box - user can expand to see details
writeThinking("Downloading file 1 of 5...");
writeThinking("File downloaded: 1.2MB");
```

**Best practice:** Use `writeThinking()` for all progress/debug messages. Only use `writeOut()` for the final result or critical errors the user must see. This keeps the chat area clean.

From `keen.json`:
```json
{
    "id": "pdf-extractor",        // <-- USE THIS in flow.run()
    "name": "PDFExtractorAgent",
    "entry_flow": "PDFExtractor",
    "entry_node": "Start"
}
```

```javascript
// CORRECT - Use the agent ID
await flow.run('pdf-extractor', { promptMessage });

// WRONG - Do NOT use FlowName-EntryNode format
await flow.run('PDFExtractor-Start', { promptMessage });  // This will fail silently!
```

### Parallel Flow Execution

```javascript
const items = dictionary.itemsToProcess;

const flowPromises = items.map(item =>
    flow.run('process-item', {  // Use agent ID from keen.json
        promptMessage: {
            role: 'user',
            content: JSON.stringify(item),
            userSessionCredentials: {
                sessionID: `${parentSessionID}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                userID: parentUserID,
            },
            agentChat: false
        }
    })
);

await Promise.all(flowPromises);
```

---

## Proxy Services for External APIs

### Why Proxies Are Needed

The VM sandbox where tools run has restricted access:
- ✅ `fetch()` - HTTP requests allowed
- ✅ `dictionary` - Data passing
- ❌ `fs` - No filesystem access
- ❌ `child_process` - No process spawning

When an external API needs actual file bytes (not just a path), a proxy service bridges the gap.

### Proxy Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ Docker Container (VM Sandbox)                                       │
│                                                                     │
│ Tool: my-tool.js                                                    │
│ - Has file path: /app/uploads/file.pdf                              │
│ - Cannot read file (no fs access)                                   │
│ - Calls proxy via fetch()                                           │
└─────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Host Machine (Proxy Service)                                        │
│                                                                     │
│ - Receives path from tool                                           │
│ - Translates path: /app/uploads → C:/Users/.../uploads              │
│ - Reads actual file bytes                                           │
│ - Forwards to external API as multipart/form-data                   │
│ - Saves response to output path                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Path Translation in Proxy

When the proxy runs on a different machine than Docker, paths need translation:

```javascript
const PATH_MAPPINGS = {
    '/app/uploads': 'C:/Users/username/Documents/KeenAgentsStorage/uploads',
    '/app/projects': 'C:/Users/username/Documents/KeenAgentsStorage/projects',
};

function translatePath(containerPath) {
    for (const [dockerPath, hostPath] of Object.entries(PATH_MAPPINGS)) {
        if (containerPath.startsWith(dockerPath)) {
            return containerPath.replace(dockerPath, hostPath);
        }
    }
    return containerPath;
}
```

---

## Google Drive Integration

### Available GDrive Tools

| Tool | Purpose |
|------|---------|
| `GDrive List Folder` | List contents of a folder |
| `GDrive Download File` | Download file to local storage |
| `GDrive Upload File` | Upload file from local storage |
| `GDrive Create Folder` | Create a new folder |
| `GDrive Move Item` | Move file/folder |
| `GDrive Rename Item` | Rename file/folder |

### Download from GDrive to Shared Volume

```javascript
// In a flow script (not a tool)
const GDRIVE_API_URL = 'http://host.docker.internal:3110';

// Download file from GDrive
const response = await fetch(`${GDRIVE_API_URL}/files/${fileId}/download`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'your-api-key'
    },
    body: JSON.stringify({
        // Use HOST path (where GDrive API writes)
        destinationPath: 'C:/Users/.../KeenAgentsStorage/uploads/session/file.pdf'
    })
});

// Store CONTAINER path (where engine reads)
dictionary.downloadedFilePath = '/app/uploads/session/file.pdf';
```

### Autonomous Processing Pattern (FullAutonomy)

A flow that processes files from a GDrive folder without user interaction:

```
Start
  ↓
[Script: List GDrive "For Processing" folder]
  ↓
[Script: Download first file to shared volume]
  ↓
[Script: Call PDFExtractor agent with file attached]
  ↓
[Agent: Analyzes PDF, calls extraction tool]
  ↓
[Tool: Splits PDF, saves ZIP to shared volume]
  ↓
End
```

---

## Sandbox Built-in Functions

Scripts running in the VM sandbox have access to these functions:

| Function | Purpose |
|----------|---------|
| `writeOut(message)` | Send output to user |
| `writeThinking(message)` | Send thinking/progress update |
| `writeError(message)` | Send error message |
| `dictionary` | Shared data object between nodes |
| `fetch(url, options)` | Make HTTP requests |

### Available Node.js Modules (Limited)

```javascript
// Allowed imports
import { createHash } from 'node:crypto';
import { TextEncoder, URL } from 'node:util';
import { Buffer } from 'node:buffer';
import { join, basename } from 'node:path';

// Special import for calling other flows
import flow from 'system/flow';
```

---

# Sub-Agent Orchestration (Advanced)

This section covers how to spawn multiple agents in parallel, track their progress, aggregate results, and handle errors. This is the key pattern for batch processing workflows.

## Sub-Agent Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Parent Flow (Orchestrator)                                               │
│                                                                          │
│ orchestrator.js                                                          │
│ ├── Lists items to process                                               │
│ ├── Spawns N sub-agents in parallel (Promise.all)                        │
│ ├── Each sub-agent has unique sessionId                                  │
│ ├── Collects results as they complete                                    │
│ └── Generates final report                                               │
│                                                                          │
│      ┌─────────────┐   ┌─────────────┐   ┌─────────────┐                │
│      │ Sub-Agent 1 │   │ Sub-Agent 2 │   │ Sub-Agent 3 │   ...          │
│      │ sessionId_1 │   │ sessionId_2 │   │ sessionId_3 │                │
│      └─────────────┘   └─────────────┘   └─────────────┘                │
│              │                 │                 │                       │
│              └────────────────┬┴─────────────────┘                       │
│                               ▼                                          │
│                    Results Aggregation                                   │
│                               ▼                                          │
│                      Final Report                                        │
└─────────────────────────────────────────────────────────────────────────┘
```

## Session ID Management

Each sub-agent needs a unique session ID for:
- Progress tracking in the UI
- Distinguishing parallel executions
- Linking parent ↔ child relationships

### Session ID Pattern

```javascript
// Parent session comes from the original request
const parentSessionId = dictionary.promptMessage.userSessionCredentials.sessionID;
const parentUserId = dictionary.promptMessage.userSessionCredentials.userID;

// Generate unique child session ID
function generateSubAgentSessionId(parentSessionId) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substr(2, 9);
    return `${parentSessionId}_${timestamp}_${random}`;
}

// Example: "main123_1706789012345_x7k9m2abc"
```

## Progress Reporting to UI

The three core functions for real-time UI updates:

### writeAgentStart(mainSessionId, subSessionId, agentName, description)

Signals that a sub-agent has started. This creates a new agent entry in the UI.

```javascript
const subSessionId = generateSubAgentSessionId(parentSessionId);

writeAgentStart(
    parentSessionId,           // Main session (links to parent)
    subSessionId,              // This sub-agent's unique ID
    'PDFProcessor',            // Agent name (displayed in UI)
    'Processing invoice.pdf'   // Description (what it's doing)
);
```

### writeAgentStream(sessionId, message)

Sends progress updates that appear in the UI in real-time.

```javascript
writeAgentStream(subSessionId, 'Downloading file from GDrive...');
writeAgentStream(subSessionId, 'File downloaded successfully');
writeAgentStream(subSessionId, 'Analyzing PDF structure...');
writeAgentStream(subSessionId, 'Found 5 documents to split');
writeAgentStream(subSessionId, 'Extracting pages 1-10...');
```

### writeAgentEnd(sessionId, status)

Signals that the sub-agent has completed. Status can be:
- `'completed'` - Success
- `'error'` - Failed
- `'warning'` - Completed with issues

```javascript
// Success
writeAgentEnd(subSessionId, 'completed');

// Error
writeAgentEnd(subSessionId, 'error');

// Completed with warnings
writeAgentEnd(subSessionId, 'warning');
```

## Complete Orchestrator Pattern

Here's a full example of an orchestrator script that processes multiple items in parallel:

```javascript
import flow from 'system/flow';

export async function exec() {
    const items = dictionary.itemsToProcess;  // Array of items
    const parentSessionId = dictionary.promptMessage.userSessionCredentials.sessionID;
    const parentUserId = dictionary.promptMessage.userSessionCredentials.userID;

    writeOut(`Starting batch processing of ${items.length} items...`);

    // Track results
    const results = {
        successful: [],
        failed: [],
        total: items.length
    };

    // Create promises for parallel execution
    const processingPromises = items.map(async (item, index) => {
        // Generate unique session ID for this sub-agent
        const subSessionId = `${parentSessionId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Signal start to UI
        writeAgentStart(
            parentSessionId,
            subSessionId,
            'ItemProcessor',
            `Processing item ${index + 1}: ${item.name}`
        );

        try {
            // Progress update
            writeAgentStream(subSessionId, `Starting processing...`);

            // Call the sub-flow
            const result = await flow.run('ProcessItem-Start', {
                promptMessage: {
                    role: 'user',
                    content: JSON.stringify(item),
                    userSessionCredentials: {
                        sessionID: subSessionId,
                        userID: parentUserId,
                    },
                    agentChat: false
                }
            });

            // Success
            writeAgentStream(subSessionId, `Completed successfully`);
            writeAgentEnd(subSessionId, 'completed');

            results.successful.push({
                item: item.name,
                result: result
            });

        } catch (error) {
            // Error - but don't throw, collect the failure
            writeAgentStream(subSessionId, `Error: ${error.message}`);
            writeAgentEnd(subSessionId, 'error');

            results.failed.push({
                item: item.name,
                error: error.message,
                step: 'processing'  // Track which step failed
            });
        }
    });

    // Wait for ALL to complete (success or failure)
    await Promise.all(processingPromises);

    // Store results for report generation
    dictionary.batchResults = results;

    // Generate summary
    writeOut(`\n=== Batch Processing Complete ===`);
    writeOut(`Total: ${results.total}`);
    writeOut(`Successful: ${results.successful.length}`);
    writeOut(`Failed: ${results.failed.length}`);
}
```

## Error Handling: Continue on Failure

Critical principle: **One failure should not stop the entire batch.**

### Wrap Each Sub-Agent in Try-Catch

```javascript
const promises = items.map(async (item) => {
    try {
        // Process item
        return { success: true, item, result };
    } catch (error) {
        // Don't rethrow - collect the error
        return { success: false, item, error: error.message };
    }
});

const results = await Promise.all(promises);

// Separate successes and failures
const successes = results.filter(r => r.success);
const failures = results.filter(r => !r.success);
```

### Track Which Step Failed

For multi-step pipelines, track where the failure occurred:

```javascript
try {
    writeAgentStream(sessionId, 'Step 1: Downloading...');
    const file = await downloadFile(item);

    writeAgentStream(sessionId, 'Step 2: Extracting...');
    const extracted = await extractPdf(file);

    writeAgentStream(sessionId, 'Step 3: Uploading...');
    const uploaded = await uploadFiles(extracted);

    return { success: true, ...uploaded };

} catch (error) {
    return {
        success: false,
        failedStep: currentStep,  // Which step failed
        error: error.message
    };
}
```

## Result Aggregation

### Simple Aggregation

```javascript
const allResults = await Promise.all(promises);

dictionary.report = {
    timestamp: new Date().toISOString(),
    total: allResults.length,
    successful: allResults.filter(r => r.success).length,
    failed: allResults.filter(r => !r.success).length,
    details: allResults
};
```

### Structured Aggregation by Step

For pipelines with multiple steps:

```javascript
const report = {
    overview: {
        total: items.length,
        fullySuccessful: 0,
        partiallySuccessful: 0,
        failed: 0
    },
    byStep: {
        download: { success: 0, failed: 0 },
        extract: { success: 0, failed: 0 },
        upload: { success: 0, failed: 0 }
    },
    items: []
};

// Populate from results
results.forEach(r => {
    if (r.success) {
        report.overview.fullySuccessful++;
        report.byStep.download.success++;
        report.byStep.extract.success++;
        report.byStep.upload.success++;
    } else {
        // Track which step failed
        const failedStep = r.failedStep;
        // Steps before failure succeeded
        // Steps at and after failure... mark accordingly
    }
    report.items.push(r);
});
```

## Generating Markdown Reports

Output a clean report at the end:

```javascript
function generateMarkdownReport(results) {
    let md = `# Batch Processing Report\n\n`;
    md += `**Date:** ${new Date().toISOString()}\n\n`;
    md += `## Summary\n\n`;
    md += `- **Total items:** ${results.total}\n`;
    md += `- **Successful:** ${results.successful.length}\n`;
    md += `- **Failed:** ${results.failed.length}\n\n`;

    if (results.successful.length > 0) {
        md += `## Successful Items\n\n`;
        results.successful.forEach(item => {
            md += `- **${item.name}**\n`;
            md += `  - Output folder: ${item.outputFolderUrl}\n`;
            md += `  - Files created: ${item.filesCreated}\n`;
        });
    }

    if (results.failed.length > 0) {
        md += `## Failed Items\n\n`;
        results.failed.forEach(item => {
            md += `- **${item.name}**\n`;
            md += `  - Failed at: ${item.failedStep}\n`;
            md += `  - Error: ${item.error}\n`;
        });
    }

    return md;
}

// Output to user
writeOut(generateMarkdownReport(dictionary.batchResults));
```

## Best Practices Summary

| Practice | Description |
|----------|-------------|
| Unique Session IDs | Always generate unique IDs: `${parent}_${timestamp}_${random}` |
| Progress Updates | Use writeAgentStream for real-time feedback |
| Error Isolation | Wrap each sub-agent in try-catch, don't let one failure crash all |
| Result Collection | Always collect both successes and failures |
| Step Tracking | Track which step failed for better debugging |
| Final Report | Generate a clean summary at the end |

---

# Critical Lessons Learned

This section documents critical technical discoveries that caused significant debugging time. Read this carefully to avoid the same pitfalls.

## 1. LLM Response Format from flow.run()

**Problem:** When calling `flow.run()` to invoke an agent, the result structure is NOT what you might expect.

**WRONG - Returns undefined:**
```javascript
const result = await flow.run('deal-recognizer', { promptMessage });
const agentOutput = result?.DealRecognitionAgent;  // ❌ UNDEFINED!
```

**CORRECT - The output is nested:**
```javascript
const result = await flow.run('deal-recognizer', { promptMessage });
const agentOutput = result?.llmResponse_DealRecognitionAgent?.output || '';  // ✅
```

**Full result structure:**
```javascript
{
  promptMessage: {...},
  __agentToolLoops: {...},
  llmResponse_DealRecognitionAgent: {   // Note: llmResponse_ prefix!
    output: "The actual text response from the agent",  // The string you want
    error: null,
    name: "DealRecognitionAgent"
  }
}
```

**Key insight:** The agent name is prefixed with `llmResponse_` and the actual text is in the `.output` property.

---

## 2. VM Sandbox - No Filesystem Access

**Critical Understanding:** Flow scripts and tools run inside a sandboxed VM (Virtual Machine) that does **NOT** have direct access to the host filesystem.

**What this means:**
- ❌ `fs.readFileSync()` - Does NOT work
- ❌ `fs.writeFileSync()` - Does NOT work
- ❌ `fs.existsSync()` - Does NOT work
- ❌ Any `fs` module operations - Do NOT work

**What DOES work in the sandbox:**
- ✅ `fetch()` - HTTP requests
- ✅ `dictionary` - Data passing between nodes
- ✅ `writeThinking()`, `writeOut()`, `writeError()` - UI output
- ✅ Limited Node modules: `crypto`, `Buffer`, `path` (for string operations only)

**Solution:** Use a proxy service running on the host to handle all filesystem operations.

```javascript
// WRONG - Direct filesystem access
const content = fs.readFileSync('/app/uploads/file.pdf');  // ❌ FAILS

// CORRECT - Call proxy service via HTTP
const response = await fetch('http://host.docker.internal:3111/api/pdf/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filePath: '/app/uploads/file.pdf' })
});
const data = await response.json();  // ✅ Proxy reads file and returns content
```

---

## 3. External APIs Cannot Access Local File Paths

**Problem:** When calling external APIs (outside your infrastructure), you CANNOT send a file path and expect the API to read it.

**Why this fails:**
```javascript
// Your local path
const filePath = 'C:/Users/vicit/Documents/file.pdf';

// Sending to remote API
await fetch('https://external-api.com/upload', {
    body: JSON.stringify({ filePath: filePath })  // ❌ FAILS
});
// The remote server doesn't have access to your C: drive!
```

**Solution:** Send the file CONTENT (as base64), not the file PATH:

```javascript
// Proxy reads file and converts to base64
const proxyResponse = await fetch('http://host.docker.internal:3111/api/file/base64', {
    method: 'POST',
    body: JSON.stringify({ filePath: '/app/uploads/file.pdf' })
});
const { base64, fileName, fileType } = await proxyResponse.json();

// Send base64 content to external API
await fetch('https://external-api.com/upload', {
    body: JSON.stringify({
        file_data: base64,      // Base64 encoded content
        file_name: fileName,
        file_type: fileType
    })
});
```

**Architecture pattern for external API calls:**

```
Script (VM)
    ↓ HTTP (send file path)
PDF Proxy (Host - has filesystem access)
    ↓ Reads file, converts to base64
    ↓ Calls external API with base64 payload
External API
    ↓
Returns result to Proxy
    ↓
Proxy returns result to Script
```

---

## 4. Debug Logging - writeThinking() Not console.log()

**Problem:** `console.log()` output is NOT visible when running in the VM sandbox.

```javascript
// WRONG - Output goes nowhere
console.log('Debug info');  // ❌ You will never see this

// CORRECT - Shows in Chat UI thinking panel
writeThinking('Debug info');  // ✅ Visible in UI
```

**Available output functions:**

| Function | Where it appears | Use for |
|----------|------------------|---------|
| `writeThinking(msg)` | Thinking panel (collapsible) | Debug logs, progress |
| `writeOut(msg)` | Main chat area | Final results, reports |
| `writeError(msg)` | Error display | Critical errors |
| `writeAgentStream(sessionId, msg)` | Sub-agent panel | Real-time progress |

---

## 5. Agent File Attachment - filePaths in promptMessage

**Problem:** How do you make an agent "see" a PDF file?

**Solution:** Use `filePaths` in the promptMessage. Gemini (multimodal) will see the file content directly.

```javascript
const promptMessage = {
    role: 'user',
    content: 'Analyze this document and find the reference numbers.',
    filePaths: [{ path: '/app/uploads/document.pdf' }],  // ← File attachment
    userSessionCredentials: {
        sessionID: subSessionId,
        userID: userId
    },
    agentChat: false
};

await flow.run('deal-recognizer', { promptMessage });
```

**Critical:** When using `filePaths`, the agent's system prompt should NOT include a "Read File" tool. The file is already visible to the agent - adding a Read File tool just confuses it and wastes time.

**WRONG system prompt:**
```markdown
1. Use the Read File tool to read the PDF  ← WRONG! File is already attached
2. Analyze the content
```

**CORRECT system prompt:**
```markdown
The PDF file is already attached - you can see its contents directly.
1. Analyze the document to find reference numbers
2. Use the lookup tool to search for deals
```

---

## 6. Agent Output Format for Parsing

**Problem:** When a downstream script needs to parse agent output, the agent must output in a predictable format.

**Bad - Conversational output (hard to parse):**
```
I found the deal! The reference is SBGSI25037859 and it's a pratka type order.
```

**Good - Structured output (easy to parse):**
```
DEAL_FOUND
item: pratka
itemId: 1966193
item_uml_ref: SBGSI25037859
```

**In the agent's system prompt, be explicit:**
```markdown
## Output Format

**If deal found**, output EXACTLY this format:

```
DEAL_FOUND
item: pratka
itemId: 1234567
item_uml_ref: SBGSI25037859
```

**If no deal found**:

```
NO_DEAL_FOUND
Tried references: REF1, REF2, REF3
```

Do not add extra commentary - just the structured output.
```

---

## 7. API Field Name Casing Matters

**Problem:** API field names are case-sensitive. `itemId` ≠ `itemID`.

**Real example that caused failures:**
```javascript
// WRONG - lowercase 'd'
body: JSON.stringify({
    item: item,
    itemId: itemId,  // ❌ API expects itemID
    docType: docType
})

// CORRECT - capital 'D'
body: JSON.stringify({
    item: item,
    itemID: itemId,  // ✅ Matches API expectation
    docType: docType
})
```

**Lesson:** Always check the exact field names expected by the API. When you get validation errors like `"itemID should not be empty"`, check the casing.

---

## Summary Table

| Issue | Wrong Approach | Correct Approach |
|-------|----------------|------------------|
| Getting agent output | `result?.AgentName` | `result?.llmResponse_AgentName?.output` |
| Reading files in script | `fs.readFileSync()` | Call proxy via `fetch()` |
| Sending files to external API | Send file path | Send base64 content via proxy |
| Debug logging | `console.log()` | `writeThinking()` |
| Agent seeing files | Read File tool | `filePaths` in promptMessage |
| Agent output format | Conversational text | Structured format for parsing |
| API field names | Guess the casing | Check exact API specification |

---
