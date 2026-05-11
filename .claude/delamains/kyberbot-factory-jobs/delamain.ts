import { defineDelamain } from "als:authoring";

export const delamain = defineDelamain({
  "phases": [
    "research",
    "implementation",
    "closed"
  ],
  "states": {
    "drafted": {
      "initial": true,
      "phase": "research",
      "actor": "agent",
      "provider": "anthropic",
      "resumable": false,
      "path": "agents/draft-gate.md"
    },
    "draft-input": {
      "phase": "research",
      "actor": "operator"
    },
    "research": {
      "phase": "research",
      "actor": "agent",
      "provider": "anthropic",
      "resumable": true,
      "session-field": "research_session",
      "path": "agents/research.md"
    },
    "research-gate": {
      "phase": "research",
      "actor": "agent",
      "provider": "anthropic",
      "resumable": false,
      "path": "agents/research-gate.md"
    },
    "research-input": {
      "phase": "research",
      "actor": "operator"
    },
    "planning": {
      "phase": "research",
      "actor": "agent",
      "provider": "anthropic",
      "resumable": true,
      "session-field": "planner_session",
      "path": "agents/planning.md"
    },
    "planning-gate": {
      "phase": "research",
      "actor": "agent",
      "provider": "anthropic",
      "resumable": false,
      "path": "agents/planning-gate.md"
    },
    "plan-input": {
      "phase": "research",
      "actor": "operator"
    },
    "dev": {
      "phase": "implementation",
      "actor": "agent",
      "provider": "anthropic",
      "resumable": true,
      "session-field": "dev_session",
      "path": "agents/dev.md"
    },
    "in-review": {
      "phase": "implementation",
      "actor": "agent",
      "provider": "anthropic",
      "resumable": false,
      "path": "agents/in-review.md"
    },
    "testing": {
      "phase": "implementation",
      "actor": "agent",
      "provider": "openai",
      "resumable": true,
      "session-field": "testing_session",
      "path": "agents/testing.md"
    },
    "test-input": {
      "phase": "implementation",
      "actor": "operator"
    },
    "done": {
      "phase": "closed",
      "terminal": true
    },
    "shelved": {
      "phase": "closed",
      "terminal": true
    },
    "cancelled": {
      "phase": "closed",
      "terminal": true
    }
  },
  "transitions": [
    { "class": "advance", "from": "drafted", "to": "research" },
    { "class": "advance", "from": "drafted", "to": "draft-input" },
    { "class": "advance", "from": "draft-input", "to": "drafted" },
    { "class": "advance", "from": "research", "to": "research-gate" },
    { "class": "advance", "from": "research-gate", "to": "research-input" },
    { "class": "advance", "from": "research-gate", "to": "planning" },
    { "class": "rework", "from": "research-input", "to": "research" },
    { "class": "advance", "from": "research-input", "to": "planning" },
    { "class": "advance", "from": "planning", "to": "planning-gate" },
    { "class": "advance", "from": "planning-gate", "to": "plan-input" },
    { "class": "advance", "from": "planning-gate", "to": "dev" },
    { "class": "rework", "from": "plan-input", "to": "planning" },
    { "class": "advance", "from": "plan-input", "to": "dev" },
    { "class": "rework", "from": "dev", "to": "planning" },
    { "class": "advance", "from": "dev", "to": "in-review" },
    { "class": "rework", "from": "in-review", "to": "dev" },
    { "class": "advance", "from": "in-review", "to": "testing" },
    { "class": "advance", "from": "testing", "to": "test-input" },
    { "class": "exit", "from": "testing", "to": "done" },
    { "class": "rework", "from": "test-input", "to": "dev" },
    { "class": "exit", "from": "test-input", "to": "done" },
    {
      "class": "exit",
      "from": [
        "drafted",
        "draft-input",
        "research",
        "research-gate",
        "research-input",
        "planning",
        "planning-gate",
        "plan-input",
        "dev",
        "in-review",
        "testing",
        "test-input"
      ],
      "to": "shelved"
    },
    {
      "class": "exit",
      "from": [
        "drafted",
        "draft-input",
        "research",
        "research-gate",
        "research-input",
        "planning",
        "planning-gate",
        "plan-input",
        "dev",
        "in-review",
        "testing",
        "test-input"
      ],
      "to": "cancelled"
    }
  ]
} as const);

export default delamain;
