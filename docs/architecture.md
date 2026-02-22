# Architecture

This document describes KyberBot's system architecture, component relationships, data flow, and file structure.

---

## Two-Mode Architecture

KyberBot operates in two modes depending on how it interacts with Claude Code:

### Subscription Mode (Primary)

In subscription mode, KyberBot uses the Claude Code CLI (`claude`) as its runtime. This is the default and recommended mode.

- No API keys to manage
- No per-token costs beyond the Claude Code subscription
- Full access to Claude Code features: sub-agents, MCP servers, skills, file editing, git
- The agent runs as a Claude Code session with KyberBot's CLAUDE.md loaded

```
User ─▶ claude CLI ─▶ CLAUDE.md context ─▶ KyberBot agent
```

### SDK Mode (Advanced)

For programmatic integration, KyberBot can interface with Claude via the Anthropic SDK. This mode is used by:

- The heartbeat scheduler (spawns headless Claude Code sessions)
- Messaging channels (forward messages to Claude Code)
- External integrations that call the agent via API

```
Heartbeat/Channel ─▶ claude --print --prompt "..." ─▶ KyberBot agent
```

Both modes use the same brain, skills, and living documents.

---

## Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         User Interfaces                          │
│                                                                  │
│  ┌──────────┐    ┌───────────┐    ┌────────────┐               │
│  │ Terminal  │    │ Telegram  │    │  WhatsApp  │               │
│  │ (claude)  │    │   Bot     │    │  Bridge    │               │
│  └─────┬─────┘    └─────┬─────┘    └─────┬──────┘               │
│        │                │                │                       │
│        └────────────────┼────────────────┘                       │
│                         │                                        │
│                    ┌────▼────┐                                   │
│                    │ KyberBot│                                   │
│                    │  Server │                                   │
│                    └────┬────┘                                   │
├─────────────────────────┼───────────────────────────────────────┤
│                    Core Services                                 │
│                         │                                        │
│  ┌──────────┐    ┌─────▼──────┐                                │
│  │Heartbeat │    │  Claude    │                                │
│  │Scheduler │───▶│  Code      │                                │
│  └──────────┘    │  Runtime   │                                │
│                  └─────┬──────┘                                  │
│                        │                                         │
├────────────────────────┼────────────────────────────────────────┤
│                   Agent Context                                  │
│                        │                                         │
│  ┌─────────┐    ┌─────▼──────┐    ┌────────────┐               │
│  │ SOUL.md │    │  CLAUDE.md │    │ HEARTBEAT  │               │
│  │         │    │ (operating │    │    .md      │               │
│  │         │    │  system)   │    │            │               │
│  └─────────┘    └────────────┘    └────────────┘               │
│  ┌─────────┐    ┌────────────┐                                  │
│  │ USER.md │    │  skills/   │                                  │
│  │         │    │            │                                  │
│  └─────────┘    └────────────┘                                  │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│                        Brain                                     │
│                                                                  │
│  ┌────────────┐  ┌────────────┐  ┌─────────────┐               │
│  │  ChromaDB  │  │    SQLite      │  │   brain/    │            │
│  │  (Docker)  │  │                │  │ (markdown)  │            │
│  │            │  │entity-graph.db │  │             │            │
│  │  vectors,  │  │ timeline.db    │  │  knowledge  │            │
│  │  metadata  │  │ sleep.db       │  │  documents  │            │
│  └────────────┘  └────────────────┘  └─────────────┘            │
│                                                                  │
│  ┌────────────────────────────────────────────┐                 │
│  │              Sleep Agent                    │                 │
│  │  decay ▶ tag ▶ link ▶ tier ▶ summarize ▶  │                 │
│  │  entity hygiene                             │                 │
│  └────────────────────────────────────────────┘                 │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│                  Optional: Kybernesis Cloud                      │
│                                                                  │
│  ┌────────────────────────────────────────────┐                 │
│  │  Cloud backup, cross-device sync, web UI   │                 │
│  └────────────────────────────────────────────┘                 │
└──────────────────────────────────────────────────────────────────┘
```

---

## Service Startup Order

When you run `kyberbot`, services start in this order:

```
1. Configuration Loading
   └─ Read identity.yaml, .env, CLAUDE.md

2. ChromaDB (Docker)
   └─ Start container, wait for health check

3. SQLite Databases
   └─ Open/create entity-graph.db, timeline.db, sleep.db

4. Sleep Agent
   └─ Begin background maintenance cycle

5. Heartbeat Scheduler
   └─ Parse HEARTBEAT.md, calculate next run times
   └─ Start timer loop

6. Channels
   └─ Start Telegram bot (if configured)
   └─ Start WhatsApp bridge (if configured)

7. HTTP Server
   └─ Listen for webhooks and channel messages

8. Ready
   └─ Display splash screen and service status
```

If a non-critical service fails to start (e.g., Telegram token is invalid), KyberBot continues with the remaining services and reports the error.

---

## Data Flow

### Conversation Flow

```
User types in terminal
       │
       ▼
Claude Code loads CLAUDE.md
       │
       ▼
CLAUDE.md instructs Claude to read SOUL.md, USER.md
       │
       ▼
Agent processes message with full context
       │
       ├──▶ Searches brain (ChromaDB + SQLite)
       ├──▶ Queries entity graph
       ├──▶ Checks timeline
       ├──▶ Loads relevant skills
       │
       ▼
Agent generates response
       │
       ├──▶ Stores new memories in ChromaDB
       ├──▶ Updates entity graph
       ├──▶ Logs to timeline
       ├──▶ Updates USER.md / SOUL.md (if new info)
       │
       ▼
Response displayed to user
```

### Heartbeat Flow

```
Heartbeat scheduler checks HEARTBEAT.md
       │
       ▼
Task is due (based on cadence + heartbeat-state.json)
       │
       ▼
Spawn Claude Code session:
  claude --print --prompt "[task instructions]"
       │
       ▼
Agent executes task with full context
       │
       ▼
Results stored in brain / displayed in channel
       │
       ▼
heartbeat-state.json updated (lastRun, nextRun)
```

### Channel Message Flow

```
Message arrives (Telegram webhook / WhatsApp event)
       │
       ▼
Server authenticates sender
       │
       ▼
Message queued for processing
       │
       ▼
Spawn Claude Code session with message as input
       │
       ▼
Agent processes with full context
       │
       ▼
Response sent back through originating channel
       │
       ▼
Conversation stored in brain + timeline
```

### Sleep Agent Flow

```
Sleep cycle triggered (interval or manual)
       │
       ├──▶ 1. Decay: Reduce priority of stale memories
       ├──▶ 2. Tag: AI-refresh tags on outdated memories
       ├──▶ 3. Link: Discover edges between related memories
       ├──▶ 4. Tier: Move memories between hot/warm/archive
       ├──▶ 5. Summarize: Regenerate summaries for tier changes
       └──▶ 6. Entity Hygiene: Merge duplicates, clean orphans
       │
       ▼
Sleep state updated in data/sleep.db
       │
       ▼
Next cycle scheduled
```

---

## File Structure

```
my-agent/                          # Your KyberBot project
├── CLAUDE.md                      # Claude Code operating instructions
├── SOUL.md                        # Agent personality (living document)
├── USER.md                        # User knowledge (living document)
├── HEARTBEAT.md                   # Recurring tasks (living document)
├── identity.yaml                  # Agent identity config
├── .env                           # Secrets and configuration
├── heartbeat-state.json           # Heartbeat scheduler state
│
├── brain/                         # Markdown knowledge files
│   ├── projects/                  # Project-specific knowledge
│   ├── people/                    # People profiles
│   └── ...                        # User-defined structure
│
├── skills/                        # Skill files
│   └── my-skill/                  # Each skill is a directory
│       └── SKILL.md               # Skill definition
│
├── data/                          # Runtime data (gitignored)
│   ├── chromadb/                  # ChromaDB persistent storage
│   ├── entity-graph.db            # Entity graph (SQLite)
│   ├── timeline.db                # Timeline (SQLite)
│   ├── sleep.db                   # Sleep agent state (SQLite)
│   └── whatsapp-session/          # WhatsApp auth (if configured)
│
├── .claude/                       # Claude Code configuration
│   ├── CLAUDE.md                  # Auto-generated operating instructions
│   ├── settings.local.json        # Permissions and settings
│   └── agents/                    # Sub-agent definitions
│
├── logs/                          # Application logs
│   ├── heartbeat.log
│   ├── sleep.log
│   └── channels.log
│
├── .gitignore                     # Excludes data/, .env, logs/
└── package.json                   # Node.js dependencies
```

### What Is Git-Tracked

| Tracked | Not Tracked |
|---------|-------------|
| SOUL.md | data/ (runtime databases) |
| USER.md | .env (secrets) |
| HEARTBEAT.md | logs/ (application logs) |
| identity.yaml | heartbeat-state.json (scheduler state) |
| brain/ | node_modules/ |
| skills/ | |
| .claude/ | |

This means your agent's identity, knowledge, and skills are version-controlled, while runtime data, scheduler state, and secrets are not.

---

## Key Design Decisions

### Why Claude Code as Runtime

KyberBot deliberately builds on Claude Code rather than building a custom agent framework. This gives us:

- **Sub-agents**: Claude Code can spawn specialized agents for parallel tasks
- **MCP servers**: Connect to any MCP-compatible service
- **File system access**: Read/write any file with permission controls
- **Git integration**: Native git operations
- **Skill system**: Claude Code's built-in skill loading
- **Permission system**: Granular control over what the agent can do
- **Tool use**: Bash, read, write, search -- all built in

### Why Markdown for Everything

Living documents, skills, and knowledge files are all markdown. This makes them:

- Human-readable and editable
- Version-controllable with git
- Easy to diff and review
- Loadable as Claude Code context
- Searchable with standard tools

### Why SQLite + ChromaDB (Not Just One)

- ChromaDB excels at semantic search ("find memories about pricing")
- SQLite excels at structured queries ("who is John connected to?", "what happened on Tuesday?")
- Together they cover the full spectrum of memory access patterns

### Why Local-First

All data lives on your machine by default. Kybernesis cloud sync is optional. This ensures:

- Privacy by default
- No dependency on external services
- Full ownership of your agent's data
- Works offline
