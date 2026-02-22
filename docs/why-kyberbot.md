# Why KyberBot?

There are many ways to build a personal AI agent. This document explains why KyberBot exists, what makes it different, and who it is for.

---

## The Core Idea

Most personal AI agent projects follow the same pattern: build a custom framework, wrap an LLM API, manage tokens, handle tool calling, implement memory from scratch, and deploy a server. The result is a complex system that costs money per token and requires ongoing maintenance.

KyberBot takes a different approach: **build on top of Claude Code instead of building from scratch.**

Claude Code is already an exceptional AI agent. It can read and write files, execute shell commands, manage git repositories, spawn sub-agents, connect to MCP servers, load skills, and reason through complex multi-step tasks. It just lacks persistence -- memory, identity, scheduling, and communication channels.

KyberBot adds exactly those things. Nothing more.

---

## The Claude Code Advantage

By building on Claude Code, KyberBot inherits a set of capabilities that would take months to build from scratch:

### Sub-Agents

Claude Code can spawn specialized agents for parallel execution. Your KyberBot agent can delegate a research task to one sub-agent and a code review to another, running them simultaneously.

Custom frameworks typically run a single agent thread.

### MCP Servers

Claude Code connects to Model Context Protocol servers, giving the agent access to databases, APIs, and services through a standardized interface.

Custom frameworks require manual tool integration for each service.

### Skills

Claude Code has a built-in skill system. Skills are markdown files that teach the agent new capabilities. KyberBot extends this with auto-generation -- the agent creates its own skills on the fly.

Custom frameworks require you to write and register tools in code.

### Permission System

Claude Code provides granular permission controls. You can allow the agent to read files but not write them, execute specific commands but not others, or access certain directories but not others.

Custom frameworks typically have all-or-nothing access.

### Git Integration

Claude Code has native git support. It can commit changes, create branches, read diffs, and manage repositories. Your agent's living documents and skills can be tracked in version control.

Custom frameworks rarely have built-in version control.

### File System Access

Claude Code can read and write any file on your machine (within permission boundaries). This means the agent can manage documents, edit configurations, process data files, and maintain its own knowledge base.

Custom frameworks are usually sandboxed with limited file access.

---

## Subscription Model

KyberBot costs nothing beyond your Claude Code subscription.

| | KyberBot | API-Based Agents |
|---|----------|-----------------|
| **Base cost** | $0 (uses Claude Code subscription) | $0 |
| **Per-message cost** | $0 | $0.01-0.10+ per message |
| **Heavy usage (1000 msgs/day)** | $0 | $10-100+/day |
| **Model upgrades** | Automatic with Claude Code | Requires API migration |
| **Rate limits** | Claude Code's generous limits | API tier-dependent |

This is possible because Claude Code is a subscription product. You pay a flat monthly fee and get unlimited (within fair use) access to Claude. KyberBot simply uses the CLI interface you are already paying for.

---

## Comparison with Alternatives

### KyberBot vs LettaBot

[LettaBot](https://github.com/letta-ai/letta) is a Python-based personal AI agent framework with a custom memory system.

| Aspect | KyberBot | LettaBot |
|--------|----------|----------|
| **Language** | TypeScript | Python |
| **Runtime** | Claude Code CLI | Custom Python server |
| **LLM Access** | Claude Code subscription | API tokens (pay per use) |
| **Memory** | ChromaDB + SQLite + sleep agent | Custom memory server |
| **Self-Evolution** | Agent updates SOUL.md, USER.md autonomously | Static configuration files |
| **Skill Creation** | Agent generates skills on the fly | Manual tool registration in Python |
| **Sub-Agents** | Native Claude Code sub-agents | Single agent loop |
| **Scheduling** | HEARTBEAT.md (natural language) | External cron or scheduler |
| **Messaging** | Telegram, WhatsApp built-in | API endpoints (build your own client) |
| **Setup** | Clone + `kyberbot onboard` (2 minutes) | Docker + API keys + Python env + config |
| **MCP Support** | Native via Claude Code | None |

**When to choose LettaBot:** You want a Python-native solution, need to self-host with full control over the inference layer, or prefer to use non-Claude models.

**When to choose KyberBot:** You want the simplest path to a capable personal agent, prefer TypeScript, are already using Claude Code, or want self-evolution out of the box.

### KyberBot vs OpenClaw

[OpenClaw](https://github.com/openclaw) is a Python-based open-source agent framework focused on extensibility.

| Aspect | KyberBot | OpenClaw |
|--------|----------|----------|
| **Language** | TypeScript | Python |
| **Runtime** | Claude Code CLI | Custom Python framework |
| **LLM Access** | Claude Code subscription | API tokens (pay per use) |
| **Memory** | ChromaDB + SQLite + sleep agent | Vector DB only |
| **Self-Evolution** | Full (SOUL.md, USER.md, skills) | None (static config) |
| **Memory Maintenance** | Sleep agent (decay, tag, link, tier, summarize) | None |
| **Scheduling** | HEARTBEAT.md | No built-in scheduler |
| **Messaging** | Telegram, WhatsApp | API-only |
| **Setup** | Clone + `kyberbot onboard` | Docker + API keys + config |

**When to choose OpenClaw:** You need a highly extensible Python framework for building custom agent workflows, or you want to use models other than Claude.

**When to choose KyberBot:** You want a personal agent that works immediately, evolves over time, and does not require you to write code.

---

## Self-Evolution vs Configuration

Most agent frameworks require you to define the agent's behavior upfront: write system prompts, register tools, configure memory settings, set up scheduled tasks. When requirements change, you edit configuration files.

KyberBot flips this. You have a conversation with your agent, and it adapts:

| Traditional Approach | KyberBot Approach |
|---------------------|-------------------|
| Edit system prompt to change personality | Agent evolves SOUL.md through use |
| Write JSON config for user preferences | Agent accumulates knowledge in USER.md |
| Set up cron jobs for recurring tasks | Agent manages HEARTBEAT.md tasks |
| Code new tools in Python/TypeScript | Agent generates skills in markdown |
| Manually clean stale data | Sleep agent maintains memory quality |
| Deploy new version for changes | Changes happen in real-time |

The result is an agent that becomes more useful over time without you writing any code. Day 1 is good. Day 30 is significantly better. Day 90 is tailored to you in ways you did not plan for.

---

## Who Is KyberBot For?

### Ideal Users

- **Claude Code power users** who want their assistant to remember things between sessions
- **Developers** who want a personal agent without building a framework from scratch
- **People who value privacy** and want their data stored locally
- **Anyone tired of re-explaining context** to AI assistants every session

### Not Ideal For

- **Teams** looking for a shared agent platform (KyberBot is personal, single-user)
- **Non-Claude users** who want to use GPT, Gemini, or open-source models
- **Production API services** that need to serve multiple users at scale
- **People without a Claude Code subscription** (it is required)

---

## Philosophy

KyberBot is built on three beliefs:

1. **Your AI should know you.** Not just in this conversation, but always. Memory is not a feature -- it is the foundation.

2. **Your AI should grow.** Static configurations are a snapshot. Living documents that the agent updates are a trajectory. The agent should get better at helping you without you doing anything.

3. **Your data is yours.** Local-first. No data leaves your machine unless you choose to sync it. No vendor lock-in. MIT licensed.

---

## Getting Started

```bash
git clone https://github.com/KybernesisAI/kyberbot.git
cd kyberbot
npm install && npm run build
cd packages/cli && npm link && cd ../..

mkdir my-agent && cd my-agent
kyberbot onboard
claude
```

See [Getting Started](getting-started.md) for the full walkthrough.
