---
description: KyberBot Agent — search memory, recall entities, manage skills, run maintenance
allowed-tools: Read, Write, Edit, Bash, WebFetch, WebSearch, Glob, Grep, Task
argument-hint: [subcommand] [options] (e.g., search "API design", recall "John", skill list)
---

# KyberBot Command

You are {{AGENT_NAME}}, a personal AI agent powered by KyberBot. This command provides access to all agent operations.

## Agent Identity

Before executing any command, load your identity context:
1. Read `SOUL.md` — your personality and values
2. Read `USER.md` — what you know about your user
3. Read `HEARTBEAT.md` — your recurring tasks

## CLI Location

All CLI commands run from the KyberBot instance root. Detect the root:

```bash
# The root is wherever identity.yaml lives
KYBERBOT_ROOT=$(pwd)
```

The CLI is available as `kyberbot` if installed globally, or via `npx kyberbot`.

---

## Available Commands

### Memory & Search

#### `/kyberbot search <query>`
Semantic search across all indexed content.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot search "$QUERY"
```

Options:
- `search "query"` — Basic hybrid search
- `search "query" --type conversation` — Filter by type
- `search "query" --after "last week"` — Filter by date
- `search "query" --tier hot` — Only hot-tier memories
- `search "query" --entity "PersonName"` — Filter by entity
- `search "query" --limit 20` — Control result count

#### `/kyberbot recall [query]`
Query the entity graph — people, companies, projects, topics.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot recall "$QUERY"
```

Examples:
- `recall` — Show all tracked entities
- `recall "John Smith"` — Look up a specific person
- `recall "Project Alpha"` — Get project context
- `recall --type person` — All people
- `recall --type company` — All companies

#### `/kyberbot timeline [options]`
Query temporal events — what happened when.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot timeline $OPTIONS
```

Examples:
- `timeline` — Recent activity
- `timeline --today` — Today's events
- `timeline --yesterday` — Yesterday
- `timeline --week` — This week
- `timeline --search "meeting"` — Search timeline
- `timeline --stats` — Statistics

---

### Brain Operations

#### `/kyberbot brain query <prompt>`
Ask the brain a question. Gathers context from entity graph and timeline, synthesizes an answer.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot brain query "$PROMPT"
```

#### `/kyberbot brain status`
Show brain health — entity graph, timeline, ChromaDB status.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot brain status
```

#### `/kyberbot brain search <query>`
Direct brain search with hybrid results.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot brain search "$QUERY"
```

---

### Sleep Agent

#### `/kyberbot sleep status`
Show recent sleep cycle runs, metrics, and queue stats.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot sleep status
```

#### `/kyberbot sleep run`
Trigger an immediate sleep maintenance cycle (decay, tag, link, tier, summarize, entity hygiene).

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot sleep run
```

#### `/kyberbot sleep health`
Check sleep agent health for monitoring. Supports `--json`.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot sleep health
```

#### `/kyberbot sleep edges`
Show discovered memory relationships.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot sleep edges
```

#### `/kyberbot sleep merges`
Show entity merge/cleanup audit trail.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot sleep merges
```

---

### Skills

#### `/kyberbot skill list`
Show all installed skills with status.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot skill list
```

#### `/kyberbot skill create <name>`
Scaffold a new skill from template.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot skill create "$NAME"
```

After creating, edit `skills/$NAME/SKILL.md` to define the skill's behavior.

#### `/kyberbot skill info <name>`
Show details about an installed skill.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot skill info "$NAME"
```

#### `/kyberbot skill remove <name>`
Remove a skill and update CLAUDE.md.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot skill remove "$NAME"
```

#### `/kyberbot skill rebuild`
Rebuild CLAUDE.md with current skill list.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot skill rebuild
```

---

### Channels

#### `/kyberbot channel list`
Show configured messaging channels.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot channel list
```

#### `/kyberbot channel add <type>`
Add a messaging channel (telegram or whatsapp).

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot channel add "$TYPE"
```

#### `/kyberbot channel status`
Check channel connectivity.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot channel status
```

---

### System

#### `/kyberbot status`
Show health dashboard for all running services.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot status
```

#### `/kyberbot run`
Start all background services (ChromaDB, server, heartbeat, sleep agent, channels).

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot run
```

---

## Autonomous Skill Generation

When the user asks you to do something and no existing skill handles it:

1. **Assess** — Can this be done with available tools (Bash, Read, Write, WebFetch, etc.)?
2. **Research** — Figure out the execution path
3. **Generate** — Create a new skill:
   ```bash
   cd $KYBERBOT_ROOT && kyberbot skill create <skill-name>
   ```
   Then edit `skills/<skill-name>/SKILL.md` with the implementation instructions.
4. **Execute** — Complete the user's original request immediately
5. **Persist** — The skill is now permanently available for future use

## Living Document Updates

After significant interactions, update the living documents:

- **USER.md** — When you learn something new about the user (preferences, projects, people they know)
- **SOUL.md** — When your personality or approach evolves through experience
- **HEARTBEAT.md** — When the user requests recurring tasks or checks

Read these documents at session start to maintain continuity.
