# CLI Reference

Complete reference for all KyberBot CLI commands. **16 top-level commands, 38 subcommands.**

---

## Core

| Command | Description |
|---------|-------------|
| `kyberbot run` | Start all services |
| `kyberbot onboard` | Set up a new agent |
| `kyberbot update` | Update CLI and refresh templates |
| `kyberbot status` | Show service health dashboard |

**`run` options:** `--no-channels`, `--no-sleep`, `--no-heartbeat`, `-v/--verbose`
**`update` options:** `--check` (dry-run), `--templates` (skip CLI source update)
**`status` options:** `--json`

---

## Memory

| Command | Description |
|---------|-------------|
| `kyberbot remember <text>` | Store to timeline, entity graph, and embeddings |
| `kyberbot recall [query]` | Look up a person, project, or topic from entity graph |
| `kyberbot search <query>` | Semantic search across all indexed content |
| `kyberbot timeline` | Query timeline of events and conversations |

**`remember` options:** `-r/--response <text>`, `-c/--channel <name>`
**`search` options:** `-l/--limit`, `-t/--type`, `-e/--entity <name>`, `--entity-match <all|any>`, `-a/--after <date>`, `-b/--before <date>`, `--tier <hot|warm|archive|all>`, `--min-priority <n>`, `--json`, `--semantic-only`, `--no-group`
**`timeline` options:** `--today`, `--yesterday`, `--week`, `-s/--search <query>`, `-t/--type`, `-l/--limit`, `--stats`, `--seed`

---

## Brain

| Command | Description |
|---------|-------------|
| `kyberbot brain query <prompt>` | Ask the brain a question (search + AI synthesis) |
| `kyberbot brain search <query>` | Semantic search across the brain |
| `kyberbot brain add <file>` | Index a file into the brain |
| `kyberbot brain status` | Show brain health and statistics |

**`brain query` options:** `-l/--limit <n>`
**`brain search` options:** `-l/--limit <n>`, `--json`
**`brain add` options:** `-t/--type <type>`, `--title <title>`
**`brain status` options:** `--json`

---

## Sleep Agent

| Command | Description |
|---------|-------------|
| `kyberbot sleep status` | Show recent runs and stats |
| `kyberbot sleep run` | Run sleep cycle immediately |
| `kyberbot sleep edges` | Show memory relationships |
| `kyberbot sleep health` | Health check (for monitoring) |
| `kyberbot sleep merges` | Show entity merge/cleanup audit trail |

**`sleep edges` options:** `-l/--limit <n>`
**`sleep health` options:** `--json`
**`sleep merges` options:** `-l/--limit <n>`

---

## Heartbeat

| Command | Description |
|---------|-------------|
| `kyberbot heartbeat list` | Show tasks from HEARTBEAT.md |
| `kyberbot heartbeat status` | Show config and execution state |
| `kyberbot heartbeat run` | Trigger an immediate heartbeat tick |

---

## Skills

| Command | Description |
|---------|-------------|
| `kyberbot skill list` | Show installed skills |
| `kyberbot skill create <name>` | Scaffold a new skill |
| `kyberbot skill remove <name>` | Remove a skill |
| `kyberbot skill info <name>` | Show skill details |
| `kyberbot skill setup <name>` | Run setup script for a skill |
| `kyberbot skill rebuild` | Rebuild CLAUDE.md with current skills |

**`skill list` options:** `--json`
**`skill create` options:** `-d/--description`, `-e/--env <vars...>`, `-s/--setup`

---

## Sub-Agents

| Command | Description |
|---------|-------------|
| `kyberbot agent list` | Show installed agents |
| `kyberbot agent create <name>` | Scaffold a new agent |
| `kyberbot agent remove <name>` | Remove an agent |
| `kyberbot agent info <name>` | Show agent details |
| `kyberbot agent spawn <name> <prompt>` | Spawn an agent with a task |
| `kyberbot agent rebuild` | Rebuild CLAUDE.md with current agents |

**`agent list` options:** `--json`
**`agent create` options:** `-d/--description`, `-r/--role`, `-m/--model <haiku|sonnet|opus>`, `-t/--max-turns`

---

## Channels

| Command | Description |
|---------|-------------|
| `kyberbot channel list` | Show configured channels |
| `kyberbot channel add <type>` | Add a messaging channel |
| `kyberbot channel remove <type>` | Remove a messaging channel |
| `kyberbot channel status` | Check connectivity |

---

## Kybernesis Cloud

| Command | Description |
|---------|-------------|
| `kyberbot kybernesis query <message>` | Search the cloud brain |
| `kyberbot kybernesis list` | List all cloud memories |
| `kyberbot kybernesis status` | Check connection status |
| `kyberbot kybernesis disconnect` | Remove API key, switch to local-only |
