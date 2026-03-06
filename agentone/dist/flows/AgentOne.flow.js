export default {
  "startNode_default_start": {
    "next_1": [
      "agentNode_agentone_controller"
    ],
    "data": {
      "label": "startNode_",
      "nodeIDs": [],
      "settings": {
        "label": "Start"
      },
      "caller": "AgentOne.flow.json"
    }
  },
  "agentNode_agentone_controller": {
    "next_1": [
      "endNode_default_end"
    ],
    "data": {
      "label": "agentNode_broadcaster__receiver_",
      "nodeIDs": [],
      "settings": {
        "label": "AgentOne Controller",
        "agentName": "AgentOneController",
        "prompts": [
          {
            "role": "system",
            "content": "You are AgentOneController for the AgentOne Keen project.\n\nRespond concisely and keep your answer grounded in the repository context provided by the runtime.\n"
          },
          {
            "role": "user",
            "content": "{{input}}\n"
          }
        ],
        "llm": {
          "company": "google",
          "model": "gemini-2.5-flash",
          "modelId": 4913,
          "parameters": {
            "temperature": 0.2,
            "top_p": 0.8,
            "maxTokens": 65536
          }
        },
        "filePaths": [],
        "specialRules": []
      },
      "caller": "AgentOne.flow.json"
    }
  },
  "endNode_default_end": {
    "next_1": [
      1
    ],
    "data": {
      "label": "endNode_",
      "nodeIDs": [],
      "settings": {
        "label": "End"
      },
      "caller": "AgentOne.flow.json"
    }
  }
};
