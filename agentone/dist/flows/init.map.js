export default {
  "projectName": "agentone",
  "agents": [
    {
      "id": "agentone",
      "name": "Agent-agentone",
      "entry_flow": "Project",
      "entry_node": "Start"
    },
    {
      "id": "boyans-jokester",
      "name": "BoyansJokester",
      "entry_flow": "Chat",
      "entry_node": "Start"
    }
  ],
  "entryFile": "Project.flow.js",
  "entryMapFile": "Project.flow.map.js",
  "entryFlow": "Start",
  "controller": "Project",
  "tools": [
    {
      "name": "Test Tool",
      "type": "script",
      "entry": "tools/test-tool.js"
    }
  ]
};
