# Self-Evolution

KyberBot agents are not static configurations. They evolve. Over days, weeks, and months of use, your agent refines its personality, deepens its understanding of you, adjusts its routines, and builds new capabilities. This document explains how that works.

---

## Overview

Self-evolution happens through four mechanisms:

1. **Living Documents** -- SOUL.md, USER.md, and HEARTBEAT.md are continuously updated by the agent
2. **Skill Auto-Generation** -- The agent creates new skills when it encounters unfamiliar tasks
3. **Sub-Agent Creation** -- The agent can spawn specialized sub-agents for complex workflows
4. **Memory Maintenance** -- The sleep agent continuously refines and organizes stored knowledge

---

## Living Documents

Three markdown files define who your agent is and how it operates. The agent has permission to read and write these files during conversation.

### SOUL.md -- Personality

SOUL.md defines the agent's personality, values, communication style, and beliefs. When the agent learns something about how you prefer to interact, it updates SOUL.md to reflect that.

**Example evolution:**

- Day 1: "Be helpful and friendly."
- Day 30: "Be direct and concise. Lead with the answer, then provide context. Use bullet points for lists of 3+ items. Avoid filler phrases. When uncertain, say so explicitly rather than hedging."

The agent evolves SOUL.md based on:

- Explicit feedback ("Be more concise", "Stop using emojis")
- Implicit patterns (noticing you always skip the preamble)
- Self-reflection during evening reviews

### USER.md -- User Knowledge

USER.md is the agent's knowledge base about you. It accumulates facts, preferences, projects, relationships, goals, and routines.

**Example evolution:**

- Day 1: "Software engineer. Working on a SaaS product."
- Day 30: Detailed sections on your tech stack, team members, project timelines, health goals, family context, communication preferences, and decision-making patterns.

The agent updates USER.md when:

- You share new information about yourself
- It discovers something through conversation
- Projects or goals change
- It corrects a previous assumption

### HEARTBEAT.md -- Recurring Tasks

HEARTBEAT.md defines tasks the agent should perform on a schedule. The agent can propose new tasks, adjust frequencies, or retire tasks that are no longer useful.

**Example evolution:**

- Day 1: Morning briefing, evening review
- Day 30: Morning briefing (with custom sections), pre-meeting prep (30 min before calendar events), weekly project status, monthly health review, daily standup summary

See [Living Documents](living-documents.md) for the detailed format and structure of each file.

---

## Skill Auto-Generation

When your agent encounters a task that no existing skill handles, it can create one on the fly.

### How It Works

1. You ask the agent to do something new (e.g., "Track my running mileage")
2. The agent checks existing skills -- none found
3. The agent assesses whether this is feasible with available tools
4. It generates a new skill at `skills/<skill-name>/SKILL.md`
5. It executes the task immediately using the new skill
6. The skill persists for future use

### What a Skill Looks Like

Skills are markdown files with structured metadata and instructions:

```markdown
---
name: running-tracker
description: Track and analyze running mileage
triggers:
  - "log a run"
  - "running mileage"
  - "how far did I run"
---

# Running Tracker

## Instructions

1. When the user logs a run, extract: distance, duration, date, notes
2. Store in brain with tag "running" and entity "health"
3. When queried, calculate weekly/monthly totals
4. Compare against goals defined in USER.md
```

### Lifecycle

- **Creation** -- Automatic when needed, or manual via `kyberbot skill create <name>`
- **Discovery** -- The agent scans `skills/` at session start
- **Execution** -- Skills are loaded as context when their triggers match
- **Retirement** -- Unused skills can be removed via `kyberbot skill remove <name>`

See [Skills](skills.md) for the complete skill system reference.

---

## Sub-Agent Creation

For complex, multi-step workflows, the agent can create sub-agents. Sub-agents are Claude Code agent definitions (in `.claude/agents/`) that specialize in a specific task.

**Examples of sub-agents the agent might create:**

- A research agent that searches the web and summarizes findings
- A code review agent that analyzes PRs against your team's conventions
- A data fetcher agent that pulls information from APIs

Sub-agents are spawned by the main agent as needed and return their results to the main conversation.

---

## What Is Protected

Not everything can be modified by the agent. The following files are protected and require manual editing:

| File | Why It Is Protected |
|------|---------------------|
| `identity.yaml` | Core identity config (agent name, ID). Changing this could break integrations. |
| `.env` | Secrets and API keys. The agent should never write credentials. |
| `CLAUDE.md` | Claude Code instructions. This is the agent's operating system -- auto-generated, changes are overwritten. |
| `.claude/settings.local.json` | Claude Code settings and permissions. |

The agent can read these files but will not modify them. If it needs a change to a protected file, it will ask you to make the edit manually.

---

## Evolution Safeguards

Self-evolution is powerful but needs guardrails:

### Git History

Every change the agent makes can be tracked in git. You can:

```bash
git log --oneline SOUL.md    # See how personality evolved
git log --oneline USER.md    # See knowledge accumulation
git diff HEAD~10 SOUL.md     # Compare current vs 10 commits ago
git checkout HEAD~5 SOUL.md  # Revert to an earlier version
```

### Explicit Over Implicit

The agent prefers explicit updates:

- It tells you when it updates a living document
- Major changes are confirmed before writing
- You can instruct the agent to ask before modifying specific sections

### Review Cadence

During evening reviews (if enabled in HEARTBEAT.md), the agent can summarize what it learned and what it changed. This gives you regular checkpoints to correct course.

---

## Summary

| Mechanism | What Evolves | How | Frequency |
|-----------|-------------|-----|-----------|
| SOUL.md | Personality, style | Agent writes directly | As needed |
| USER.md | User knowledge | Agent writes directly | As new info arrives |
| HEARTBEAT.md | Recurring tasks | Agent proposes, user confirms | Weekly review |
| Skills | Capabilities | Auto-generated on demand | As needed |
| Sub-agents | Workflow specialists | Created for complex tasks | Rare |
| Memory | Knowledge quality | Sleep agent background process | Continuous |
