# Getting Started

This guide walks you through installing KyberBot, running the onboard wizard, and having your first conversation with your personal AI agent.

---

## Prerequisites

Before installing KyberBot, make sure you have:

### Required

- **Node.js 18+** -- [Download](https://nodejs.org/)
- **Docker** -- Required for ChromaDB (the vector database). [Install Docker Desktop](https://www.docker.com/products/docker-desktop/)
- **Claude Code subscription** -- KyberBot runs on top of Claude Code. You need an active subscription. [Get Claude Code](https://docs.anthropic.com/en/docs/claude-code)

### Optional

- **Git** -- For auto-sync and version history (recommended)
- **Telegram account** -- If you want to message your agent via Telegram
- **WhatsApp** -- If you want to message your agent via WhatsApp

### Verify Prerequisites

```bash
node --version    # Should be 18.0.0 or higher
docker --version  # Should show Docker version
claude --version  # Should show Claude Code version
```

---

## Installation

### Create a New Agent

```bash
npx create-kyberbot my-agent
cd my-agent
```

This scaffolds a new KyberBot project with:

- `SOUL.md` -- Agent personality (blank, ready for onboarding)
- `USER.md` -- User profile (blank, ready for onboarding)
- `HEARTBEAT.md` -- Recurring tasks (defaults provided)
- `CLAUDE.md` -- Claude Code instructions (pre-configured)
- `identity.yaml` -- Agent identity configuration
- `.env` -- Environment variables (empty, filled during onboard)
- `brain/` -- Directory for markdown knowledge files
- `skills/` -- Directory for agent skills

### Run the Onboard Wizard

```bash
kyberbot onboard
```

The onboard wizard walks you through 7 steps:

#### Step 1: Agent Name

Choose a name for your agent. This is how it will refer to itself in conversation.

```
What would you like to name your agent?
> Atlas
```

#### Step 2: Personality

Describe how your agent should communicate. Formal? Casual? Warm? Terse? The wizard writes this to `SOUL.md`.

```
Describe your agent's personality:
> Direct and concise. Warm but not chatty. Proactive about
> suggesting next steps. Prefers bullet points over paragraphs.
```

#### Step 3: About You

Tell your agent about yourself. Name, work, interests, goals. This populates `USER.md`.

```
Tell your agent about yourself:
> I'm a software engineer working on fintech products.
> I track my health with an Oura ring and run 3x/week.
> I'm trying to launch a SaaS product by Q3.
```

#### Step 4: Heartbeat Tasks

Configure recurring tasks. The wizard provides sensible defaults that you can customize.

```
Default heartbeat tasks:
  [x] Morning briefing (daily, 8:00 AM)
  [x] Evening review (daily, 9:00 PM)
  [ ] Weekly planning (Monday, 9:00 AM)
  [ ] Health check-in (daily, 7:00 AM)

Customize? (y/n)
```

#### Step 5: Messaging Channels (Optional)

Connect Telegram and/or WhatsApp. You can skip this and set it up later.

```
Set up Telegram? (y/n)
Set up WhatsApp? (y/n)
```

#### Step 6: Git Auto-Sync (Optional)

Enable automatic git commits to track your agent's evolution.

```
Enable git auto-sync? (y/n)
Sync interval (minutes): 5
```

#### Step 7: Kybernesis Cloud (Optional)

Optionally connect to Kybernesis for cloud backup and cross-device sync.

```
Connect to Kybernesis cloud? (y/n)
```

After completing onboarding, you will see:

```
 ✓ Agent "Atlas" created successfully.
 ✓ SOUL.md written
 ✓ USER.md written
 ✓ HEARTBEAT.md written
 ✓ identity.yaml configured

 Run 'kyberbot run' to start services, then 'claude' to chat.
```

---

## Starting Services

```bash
kyberbot run
```

This starts the KyberBot runtime:

1. **ChromaDB** -- Starts the Docker container for vector search
2. **Sleep Agent** -- Begins background memory maintenance
3. **Heartbeat Scheduler** -- Watches `HEARTBEAT.md` for recurring tasks
4. **Git Auto-Sync** -- Commits changes on the configured interval
5. **Channels** -- Starts any configured messaging bridges (Telegram, WhatsApp)

You will see a splash screen with service status:

```
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   _  __      _               ____        _                 ║
║  | |/ /_   _| |__   ___ _ __| __ )  ___ | |_              ║
║  | ' /| | | | '_ \ / _ \ '__|  _ \ / _ \| __|             ║
║  | . \| |_| | |_) |  __/ |  | |_) | (_) | |_              ║
║  |_|\_\\__, |_.__/ \___|_|  |____/ \___/ \__|              ║
║        |___/                                               ║
║                                                            ║
║          Your AI. Your rules. Powered by Claude Code.      ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝

  Agent: Atlas
  Root:  /home/user/my-agent

  ✓ ChromaDB         [RUNNING]
  ✓ Sleep Agent      [RUNNING]
  ✓ Heartbeat        [RUNNING]
  ✓ Git Sync         [RUNNING]  every 5m
  ✓ Telegram         [RUNNING]  @atlas_bot
  ─ WhatsApp         [DISABLED]

═════════════════════════════════════════════════════════════

  Atlas is ready.

═════════════════════════════════════════════════════════════
```

---

## Your First Conversation

With services running, open a new terminal and start Claude Code:

```bash
claude
```

Claude Code loads `CLAUDE.md`, which instructs it to behave as your KyberBot agent. Try these:

```
> Hey Atlas, what do you know about me?

> Remember that my product launch deadline is June 15th.

> What's on my schedule today?

> Create a skill for tracking my running mileage.
```

The agent will:

- Read `USER.md` to recall what it knows about you
- Store new information to the brain (ChromaDB + entity graph)
- Execute heartbeat tasks on schedule
- Generate new skills when it encounters unfamiliar tasks

---

## Service Commands

```bash
# Start all services
kyberbot run

# Start without specific services
kyberbot run --no-sleep        # Disable sleep agent
kyberbot run --no-channels     # Disable messaging channels
kyberbot run --no-git-sync     # Disable git auto-sync
kyberbot run --no-heartbeat    # Disable heartbeat scheduler

# Other commands
kyberbot status                # Show service status
kyberbot onboard               # Re-run onboard wizard
kyberbot brain search "query"  # Search memories
kyberbot brain entities        # List tracked entities
kyberbot brain timeline        # Show recent timeline
kyberbot skills list           # List installed skills
kyberbot skills create         # Create a new skill
```

---

## Next Steps

- [Self-Evolution](self-evolution.md) -- Understand how your agent evolves over time
- [Living Documents](living-documents.md) -- SOUL.md, USER.md, HEARTBEAT.md reference
- [Brain](brain.md) -- How the memory system works
- [Skills](skills.md) -- Create and manage agent skills
- [Channels](channels.md) -- Set up Telegram and WhatsApp
