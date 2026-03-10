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

#### `/kyberbot brain add <file>`
Index a file into ChromaDB for semantic search. Critical for the `brain-note` skill workflow — after writing a brain note, always run this to make the content searchable.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot brain add "$FILE"
```

Options:
- `-t, --type <type>` — Document type: `conversation`, `idea`, `file`, `transcript`, `note`
- `--title <title>` — Custom title for the indexed document

Example (after writing a brain note):
```bash
cd $KYBERBOT_ROOT && kyberbot brain add brain/architecture-decisions.md --title "Architecture Decisions" -t note
```

#### `/kyberbot brain status`
Show memory health — entity graph, timeline, and search status.

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

### Heartbeat

#### `/kyberbot heartbeat list`
Show all tasks defined in HEARTBEAT.md with their cadence and time window.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot heartbeat list
```

#### `/kyberbot heartbeat status`
Show heartbeat configuration (interval, active hours) and execution state (last run times for each task).

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot heartbeat status
```

#### `/kyberbot heartbeat run`
Trigger an immediate heartbeat tick — finds the most overdue task and executes it.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot heartbeat run
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

#### `/kyberbot skill setup <name>`
Run a skill's setup script — installs dependencies, configures environment variables, or performs other initialization. Use this when a skill has `requiresEnv` fields or a setup step.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot skill setup "$NAME"
```

#### `/kyberbot skill remove <name>`
Remove a skill and update CLAUDE.md.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot skill remove "$NAME"
```

#### `/kyberbot skill rebuild`
Rebuild CLAUDE.md with current skill and agent lists. Run this after creating/removing skills or agents, or after changing `agent_name` in identity.yaml.

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

#### `/kyberbot channel add <type> [--reverify]`
Add a messaging channel (telegram or whatsapp).

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot channel add "$TYPE"
```

Options:
- `--reverify` — Clear Telegram owner verification. A new verification code will be generated on next `kyberbot` start. Use this when you need to pair with a new phone or Telegram account.

#### `/kyberbot channel status`
Check channel connectivity and verification status.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot channel status
```

Shows whether Telegram is verified (has a confirmed owner) or pending verification.

---

### Telegram Verification

When a Telegram bot token is configured but no owner has been verified, KyberBot uses a one-time code flow to secure the connection:

1. Add a bot token: `kyberbot channel add telegram`, then set the token in `identity.yaml`
2. Start `kyberbot` — the console prints a 6-character verification code
3. Open Telegram and send `/start CODE` to your bot (e.g., `/start A1B2C3`)
4. Bot verifies the code and saves your `chat_id` as `owner_chat_id` in `identity.yaml`
5. Bot replies with a connection confirmation
6. From this point, only messages from your verified chat are processed — all others are silently ignored

**Re-verification:** Run `kyberbot channel add telegram --reverify` to clear the owner, then restart to get a new code.

**Security:** The verification code is only displayed in the server console (never sent via Telegram). Only someone with access to both the server and the Telegram account can complete verification.

---

### Update

#### `/kyberbot update`
Update KyberBot CLI source and refresh agent template files. Pulls latest changes, rebuilds, refreshes `.claude/CLAUDE.md` and other infrastructure files while preserving all user data.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot update
```

#### `/kyberbot update --check`
Preview what would change without making any modifications.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot update --check
```

#### `/kyberbot update --templates`
Only refresh template files (skip CLI source git pull and rebuild).

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot update --templates
```

**What gets refreshed**: `.claude/CLAUDE.md` (backed up first), `.claude/settings.local.json`, `.claude/commands/kyberbot.md`, `.claude/skills/skill-generator.md`, `.claude/skills/templates/skill-template.md`, `docker-compose.yml`.

**What is never touched**: `SOUL.md`, `USER.md`, `HEARTBEAT.md`, `brain/`, `skills/`, `data/`, `.env`, `heartbeat-state.json`.

---

### Remote Access & API

#### `/kyberbot tunnel setup`
Configure ngrok authtoken for remote access to the local server.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot tunnel setup
```

#### `/kyberbot tunnel status`
Check active ngrok tunnels.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot tunnel status
```

#### `/kyberbot tunnel start`
Start an ngrok tunnel to the local server port.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot tunnel start
```

#### `/kyberbot token`
Show the current API authentication token.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot token
```

#### `/kyberbot token regenerate`
Generate a new API token and update `.env`.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot token regenerate
```

---

### System

#### `/kyberbot status`
Show health dashboard for all running services.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot status
```

Options:
- `--json` — Machine-readable JSON output

#### `/kyberbot start`
Start all background services (memory, server, heartbeat, sleep agent, channels).

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot
```

Options:
- `--no-channels` — Start without Telegram/WhatsApp
- `--no-sleep` — Start without sleep agent
- `--no-heartbeat` — Start without heartbeat service
- `-v, --verbose` — Enable debug logging

#### `/kyberbot onboard`
Run the initial setup wizard. An 8-step interactive process that configures agent identity, user info, Claude mode, brain initialization, Kybernesis cloud, remote access, and messaging channels.

**Implementation:**
```bash
cd $KYBERBOT_ROOT && kyberbot onboard
```

---

### Configuration Changes

The agent can directly edit `identity.yaml` for these fields:

| Field | How to Change |
|-------|--------------|
| `agent_name` | Edit identity.yaml, then `kyberbot skill rebuild` |
| `agent_description` | Edit identity.yaml |
| `timezone` | Edit identity.yaml (IANA format, e.g. `America/New_York`) |
| `heartbeat_interval` | Edit identity.yaml (e.g. `15m`, `1h`, `30m`) |
| `heartbeat_active_hours` | Edit identity.yaml (start/end times + timezone) |
| `claude.model` | Edit identity.yaml (`opus`, `sonnet`, or `haiku`) |

For channels and tunnel config, use the CLI commands instead of direct file editing.

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
