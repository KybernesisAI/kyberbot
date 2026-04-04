```
  ██╗  ██╗██╗   ██╗██████╗ ███████╗██████╗ ██████╗  ██████╗ ████████╗
  ██║ ██╔╝╚██╗ ██╔╝██╔══██╗██╔════╝██╔══██╗██╔══██╗██╔═══██╗╚══██╔══╝
  █████╔╝  ╚████╔╝ ██████╔╝█████╗  ██████╔╝██████╔╝██║   ██║   ██║
  ██╔═██╗   ╚██╔╝  ██╔══██╗██╔══╝  ██╔══██╗██╔══██╗██║   ██║   ██║
  ██║  ██╗   ██║   ██████╔╝███████╗██║  ██║██████╔╝╚██████╔╝   ██║
  ╚═╝  ╚═╝   ╚═╝   ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═════╝  ╚═════╝    ╚═╝
```

# KyberBot

**Your AI. Your rules. Powered by Claude Code.**

KyberBot is an open-source personal AI agent that runs on top of [Claude Code](https://docs.anthropic.com/en/docs/claude-code). It gives your Claude Code instance a persistent brain, self-evolving identity, scheduled tasks, messaging channels, and skill auto-generation -- turning a CLI coding assistant into a full personal AI agent.

No API keys to manage. No inference costs beyond your Claude Code subscription. No vendor lock-in. Your data stays in your repo.

---

## Quick Start

You need three things before you start:

- **Node.js 18+** -- [Download here](https://nodejs.org/)
- **Docker Desktop** -- [Download here](https://www.docker.com/products/docker-desktop/) (used for the memory database)
- **Claude Code** -- [Get it here](https://docs.anthropic.com/en/docs/claude-code) (requires an active subscription)

### Step 1: Install KyberBot

This installs the `kyberbot` command on your machine. You only do this once.

```bash
git clone https://github.com/KybernesisAI/kyberbot.git
cd kyberbot
npm install
npm run build
cd packages/cli && npm link && cd ../..
```

Think of this like installing an app. The `kyberbot/` folder is the app itself -- you don't work inside it.

### Step 2: Create Your Agent

Create a new folder anywhere on your machine and run `kyberbot onboard` inside it:

```bash
mkdir ~/my-agent
cd ~/my-agent
kyberbot onboard
```

The onboard wizard asks you a few questions (agent name, your name, personality style) and sets up everything in this folder -- personality files, memory databases, Claude Code configuration, and more.

**This folder is your agent.** Everything it knows, everything it learns, its entire personality and memory -- all lives here.

### Updating KyberBot

When a new version is released, update the CLI and refresh your agent's template files in one command:

```bash
cd ~/my-agent
kyberbot update
```

This pulls the latest source, rebuilds the CLI, and refreshes infrastructure files (`.claude/CLAUDE.md`, settings, commands) while preserving all your agent's data (`SOUL.md`, `USER.md`, `brain/`, `skills/`, etc.).

Use `kyberbot update --check` to preview changes before applying them.

### Step 3: Start Your Agent

From your agent's folder, run:

```bash
kyberbot
```

This starts all background services (memory database, heartbeat scheduler, messaging channels). Leave this terminal running.

### Step 4: Talk to Your Agent

Open a **second terminal**, go to your agent's folder, and start Claude Code:

```bash
cd ~/my-agent
claude
```

Claude Code automatically loads your agent's personality and memory. Just start talking.

See [Getting Started](docs/getting-started.md) for the full walkthrough.

---

## Features

### Self-Evolving Identity

Your agent maintains living documents that evolve over time:

- **SOUL.md** -- Personality, values, communication style. The agent updates this as it learns who it is to you.
- **USER.md** -- Everything the agent knows about you. Preferences, projects, routines, goals.
- **HEARTBEAT.md** -- Recurring tasks the agent should perform on a schedule (daily briefings, health checks, reminders).

### Kybernesis Local (Long-Term Memory)

KyberBot has a real memory system, not just context window tricks:

- **Entity Graph** -- Tracks people, companies, projects, and their relationships
- **Timeline** -- Temporal log of events, conversations, and notes
- **Semantic Search** -- Vector-based search for meaning-based recall across all memories
- **Sleep Agent** -- Background process that maintains memory quality (decay, tagging, linking, tiering, summarization, entity hygiene)
- **Hybrid Search** -- 70% semantic + 30% keyword scoring for accurate recall

### Heartbeat Scheduler

Define recurring tasks in `HEARTBEAT.md` and KyberBot executes them on cadence:

- Morning briefings
- Evening reviews
- Health check-ins
- Project status updates
- Anything you can describe in natural language

### Messaging Channels

Talk to your agent from anywhere:

- **Telegram** -- Connect via BotFather, chat with your agent on mobile
- **WhatsApp** -- QR code authentication, full bidirectional messaging
- Extensible channel interface for adding new platforms

### Skill Auto-Generation

When your agent encounters a task it cannot handle, it creates a new skill:

- Skills are markdown files with structured instructions
- The agent generates, tests, and persists skills autonomously
- Skills accumulate over time, making the agent permanently more capable
- Full lifecycle management: list, create, remove, setup

### Kybernesis Cloud (Optional)

Connect to [Kybernesis](https://kybernesis.ai) for cloud-backed workspace memory:

- Query workspace memories from any device
- Complements local memory -- cloud results fill gaps in local recall
- API key only, no extra configuration
- Disconnect anytime with `kyberbot kybernesis disconnect`

---

## How It Works

KyberBot is not a framework that wraps an LLM. It is a layer on top of Claude Code that provides:

1. **Identity** -- SOUL.md, USER.md, and HEARTBEAT.md loaded as context
2. **Memory** -- Kybernesis Local databases the agent reads and writes via CLI tools
3. **Scheduling** -- A heartbeat loop that invokes Claude via the Agent SDK for recurring tasks
4. **Channels** -- Telegram/WhatsApp bridges that pipe messages to and from Claude
5. **Skills** -- Markdown skill files that teach the agent new capabilities

Claude Code handles the hard parts: tool use, sub-agent orchestration, MCP servers, file editing, permissions, and reasoning. KyberBot just gives it a brain and a body.

Background operations (heartbeats, channel messages) use the Agent SDK (`@anthropic-ai/claude-code`) by default, which works with your Claude Code subscription at no extra cost. An Anthropic API key can be used instead for direct SDK access.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Claude Code                        │
│  ┌─────────┐  ┌──────────┐  ┌────────┐  ┌───────────┐   │
│  │ SOUL.md │  │ USER.md  │  │Skills/ │  │ CLAUDE.md │   │
│  └─────────┘  └──────────┘  └────────┘  └───────────┘   │
├─────────────────────────────────────────────────────────┤
│                     KyberBot CLI                        │
│  ┌───────────┐  ┌───────────┐  ┌────────────────────┐   │
│  │ Heartbeat │  │ Channels  │  │ Claude Runtime     │   │
│  │ Scheduler │  │ Telegram  │  │ (Agent SDK / SDK / │   │
│  │           │  │ WhatsApp  │  │  Subprocess)       │   │
│  └─────┬─────┘  └─────┬─────┘  └─────────┬──────────┘   │
├────────┼──────────────┼──────────────────┼──────────────┤
│        │  Kybernesis  │                  │              │
│        │    Local     │                  │              │
│  ┌─────▼──────────────▼──────────────────▼──────────┐   │
│  │  Semantic       Entity Graph     brain/          │   │
│  │  Search         Timeline         (markdown       │   │
│  │  (vectors)      (structured)     knowledge)      │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  ┌────────────────────────────────────────────────┐     │
│  │              Sleep Agent                       │     │
│  │  decay → tag → link → tier → summarize →       │     │
│  │  entity hygiene                                │     │
│  └────────────────────────────────────────────────┘     │
├─────────────────────────────────────────────────────────┤
│           Optional: Kybernesis Cloud                    │
│  ┌────────────────────────────────────────────────┐     │
│  │  Cloud workspace memory (query endpoint)       │     │
│  │  API key only — complements local memory       │     │
│  └────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────┘
```

---

## Comparison

| Feature | KyberBot | LettaBot | OpenClaw |
|---------|----------|----------|----------|
| **Runtime** | Claude Code (sub-agents, MCP, skills) | Custom Python framework | Custom Python framework |
| **Cost** | $0 beyond Claude Code subscription | API token costs | API token costs |
| **Memory** | Kybernesis Local + sleep agent | Custom memory server | Vector DB only |
| **Self-Evolution** | SOUL.md, USER.md auto-update | Static config | Static config |
| **Skill Generation** | Agent creates its own skills | Manual tool registration | Manual tool registration |
| **Scheduling** | HEARTBEAT.md natural language | Cron-based | No built-in scheduler |
| **Messaging** | Telegram, WhatsApp | API endpoints | API endpoints |
| **Setup** | Clone + `kyberbot onboard` (5 minutes) | Docker + API keys + config | Docker + API keys + config |
| **Sub-Agents** | Native Claude Code sub-agents | Single agent | Single agent |
| **Permissions** | Claude Code permission system | Custom auth | Custom auth |
| **Open Source** | MIT | MIT | Apache 2.0 |

---

## Migrating from OpenClaw or Hermes-Agent?

Claude recently restricted OpenClaw and Hermes-Agent from running on Pro and Max subscriptions — they require infrastructure that operates outside the Claude Code harness. **KyberBot runs natively inside Claude Code and is completely unaffected.**

If you were using either of those tools, you can be up and running in about 5 minutes.

### Quick Migration (3 Steps)

**Step 1: Install KyberBot**

```bash
git clone https://github.com/KybernesisAI/kyberbot.git
cd kyberbot && npm install && npm run build
cd packages/cli && npm link && cd ../..
```

**Step 2: Create your agent**

```bash
mkdir ~/my-agent && cd ~/my-agent
kyberbot onboard
```

**Step 3: Start it**

```bash
kyberbot          # Start services (leave running)
# Open a second terminal:
claude            # Talk to your agent
```

No Docker. No API keys. No extra cost beyond your existing Claude subscription.

### How KyberBot Compares

| Feature | KyberBot | OpenClaw | Hermes-Agent |
|---------|----------|----------|--------------|
| **Works on Claude Pro/Max** | Yes | No (restricted) | No (restricted) |
| **Extra cost** | $0 | API tokens ($10–100+/day) | API tokens |
| **Setup time** | ~5 minutes | 30+ minutes | 30+ minutes |
| **Memory** | 6-component system (entity graph, vectors, facts, reasoning, timeline, sleep agent) | Vector DB only | Vector DB only |
| **Self-evolving** | SOUL.md, USER.md update automatically | Static config | Static config |
| **Scheduled tasks** | HEARTBEAT.md (natural language) | None | Limited |
| **Messaging** | Telegram, WhatsApp | API-only | API-only |
| **Open source** | MIT | Apache 2.0 | Varies |

### Need Help Migrating?

Visit the [GitHub Discussion](https://github.com/KybernesisAI/kyberbot/discussions) for migration help, FAQs, and community support.

---

## Documentation

- [Getting Started](docs/getting-started.md) -- Installation, onboarding, first conversation, updating
- [Self-Evolution](docs/self-evolution.md) -- How the agent evolves its identity and knowledge
- [Living Documents](docs/living-documents.md) -- SOUL.md, USER.md, HEARTBEAT.md reference
- [Brain](docs/brain.md) -- Memory architecture (Kybernesis Local, sleep agent)
- [Skills](docs/skills.md) -- Skill system and auto-generation
- [Channels](docs/channels.md) -- Telegram and WhatsApp messaging setup
- [Architecture](docs/architecture.md) -- System overview, data flow, file structure
- [Kybernesis Cloud](docs/kybernesis.md) -- Optional cloud memory
- [VPS Deployment](docs/vps-deployment.md) -- Run KyberBot on a server for 24/7 uptime
- [CLI Reference](docs/cli-reference.md) -- Complete command reference (16 commands, 38 subcommands)
- [Why KyberBot?](docs/why-kyberbot.md) -- Positioning and philosophy

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to contribute.

---

## License

MIT -- see [LICENSE](LICENSE).

---

Built with Claude Code. Maintained by the community.
