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

This downloads the KyberBot tool and makes the `kyberbot` command available on your machine.

```bash
git clone https://github.com/KybernesisAI/kyberbot.git
cd kyberbot
npm install
npm run build
cd packages/cli && npm link && cd ../..
```

You only do this once.

### Step 2: Create Your Agent

Pick a folder where your agent will live. This is separate from the KyberBot source code -- it's your agent's home, where its personality, memory, and skills are stored.

```bash
mkdir ~/my-agent
cd ~/my-agent
kyberbot onboard
```

The onboard wizard asks you a few questions (agent name, your name, personality style) and then sets up everything automatically -- identity files, memory databases, Claude Code configuration, and more. Takes about 2 minutes.

### Step 3: Start Your Agent

From your agent's folder, run:

```bash
kyberbot
```

This starts all background services (memory database, heartbeat scheduler, messaging channels). Leave this running.

### Step 4: Talk to Your Agent

Open a **new terminal**, go to your agent's folder, and start Claude Code:

```bash
cd ~/my-agent
claude
```

That's it. Claude Code loads your agent's personality and memory automatically. Just start talking.

See [Getting Started](docs/getting-started.md) for the full walkthrough.

---

## Features

### Self-Evolving Identity

Your agent maintains living documents that evolve over time:

- **SOUL.md** -- Personality, values, communication style. The agent updates this as it learns who it is to you.
- **USER.md** -- Everything the agent knows about you. Preferences, projects, routines, goals.
- **HEARTBEAT.md** -- Recurring tasks the agent should perform on a schedule (daily briefings, health checks, reminders).

### Brain (Long-Term Memory)

KyberBot has a real memory system, not just context window tricks:

- **ChromaDB** -- Vector database for semantic search across all memories
- **SQLite Entity Graph** -- Tracks people, companies, projects, and their relationships
- **SQLite Timeline** -- Temporal log of events, conversations, and notes
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

---

## How It Works

KyberBot is not a framework that wraps an LLM. It is a layer on top of Claude Code that provides:

1. **Identity** -- SOUL.md, USER.md, and HEARTBEAT.md loaded as context
2. **Memory** -- ChromaDB + SQLite databases the agent reads and writes via CLI tools
3. **Scheduling** -- A heartbeat loop that spawns Claude Code sessions for recurring tasks
4. **Channels** -- Telegram/WhatsApp bridges that pipe messages to and from Claude Code
5. **Skills** -- Markdown skill files that teach the agent new capabilities

Claude Code handles the hard parts: tool use, sub-agent orchestration, MCP servers, file editing, permissions, and reasoning. KyberBot just gives it a brain and a body.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Claude Code                         │
│  ┌─────────┐  ┌──────────┐  ┌────────┐  ┌───────────┐  │
│  │  SOUL.md │  │ USER.md  │  │Skills/ │  │ CLAUDE.md │  │
│  └─────────┘  └──────────┘  └────────┘  └───────────┘  │
├─────────────────────────────────────────────────────────┤
│                     KyberBot CLI                         │
│  ┌───────────┐  ┌───────────┐                          │
│  │ Heartbeat │  │ Channels  │                          │
│  │ Scheduler │  │ Telegram  │                          │
│  │           │  │ WhatsApp  │                          │
│  └─────┬─────┘  └─────┬─────┘                          │
├────────┼───────────────┼────────────────────────────────┤
│        │          Brain │                                │
│  ┌─────▼───────────────▼──────────────────────────┐     │
│  │  ChromaDB        SQLite          brain/        │     │
│  │  (vectors)    (entities,      (markdown        │     │
│  │               timeline,       knowledge)       │     │
│  │               sleep state)                     │     │
│  └────────────────────────────────────────────────┘     │
│                                                          │
│  ┌────────────────────────────────────────────────┐     │
│  │              Sleep Agent                        │     │
│  │  decay → tag → link → tier → summarize →       │     │
│  │  entity hygiene                                 │     │
│  └────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────┘
```

---

## Comparison

| Feature | KyberBot | LettaBot | OpenClaw |
|---------|----------|----------|----------|
| **Runtime** | Claude Code (sub-agents, MCP, skills) | Custom Python framework | Custom Python framework |
| **Cost** | $0 beyond Claude Code subscription | API token costs | API token costs |
| **Memory** | ChromaDB + SQLite + sleep agent | Custom memory server | Vector DB only |
| **Self-Evolution** | SOUL.md, USER.md auto-update | Static config | Static config |
| **Skill Generation** | Agent creates its own skills | Manual tool registration | Manual tool registration |
| **Scheduling** | HEARTBEAT.md natural language | Cron-based | No built-in scheduler |
| **Messaging** | Telegram, WhatsApp | API endpoints | API endpoints |
| **Setup** | Clone + `kyberbot onboard` (5 minutes) | Docker + API keys + config | Docker + API keys + config |
| **Sub-Agents** | Native Claude Code sub-agents | Single agent | Single agent |
| **Permissions** | Claude Code permission system | Custom auth | Custom auth |
| **Open Source** | MIT | MIT | Apache 2.0 |

---

## Documentation

- [Getting Started](docs/getting-started.md) -- Installation, onboarding, first conversation
- [Self-Evolution](docs/self-evolution.md) -- How the agent evolves its identity and knowledge
- [Living Documents](docs/living-documents.md) -- SOUL.md, USER.md, HEARTBEAT.md reference
- [Brain](docs/brain.md) -- Memory architecture (ChromaDB, SQLite, sleep agent)
- [Skills](docs/skills.md) -- Skill system and auto-generation
- [Channels](docs/channels.md) -- Telegram and WhatsApp messaging setup
- [Architecture](docs/architecture.md) -- System overview, data flow, file structure
- [Kybernesis Cloud](docs/kybernesis.md) -- Optional cloud sync
- [Why KyberBot?](docs/why-kyberbot.md) -- Positioning and philosophy

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to contribute.

---

## License

MIT -- see [LICENSE](LICENSE).

---

Built with Claude Code. Maintained by the community.
