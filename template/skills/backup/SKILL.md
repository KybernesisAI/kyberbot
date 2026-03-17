---
name: backup
description: "Back up all agent data to GitHub — SQLite databases, Claude Code memory, identity, skills, brain notes. Use when the user says backup, back up, save everything, push to github, or snapshot. Also used by heartbeat for automated backups."
version: 1.0.0
requires_env: []
has_setup: false
allowed-tools: Bash(kyberbot backup *)
---

# Backup

Backs up the complete agent state to the configured private GitHub repository.

## When to Fire

- User says "backup", "back up", "push to github", "snapshot", "save everything"
- Heartbeat automated backup task
- Before any risky operation (major upgrades, migrations)
- After significant memory or skill updates

## What Gets Backed Up

| Data | Location | Description |
|------|----------|-------------|
| Identity | SOUL.md, USER.md, HEARTBEAT.md, identity.yaml | Agent personality and config |
| Skills | skills/ | All skill definitions |
| Brain notes | brain/ | Knowledge base documents |
| SQLite DBs | data/*.db (entity graph, timeline, sleep, messages) | Structured memory |
| ChromaDB | data/chromadb/ | Vector embeddings for semantic search |
| Claude Code memory | data/claude-memory/ (synced from ~/.claude) | Claude Code project memory |
| Config | docker-compose.yml, .claude/, .gitignore | Infrastructure config |

## How to Run

```bash
kyberbot backup run
```

This single command handles the full backup flow:
1. Checkpoints SQLite WAL files (merges uncommitted writes into .db files)
2. Syncs Claude Code memory files into the repo
3. Commits all changes with a timestamped message
4. Pushes to the configured GitHub remote

To verify backup integrity:
```bash
kyberbot backup verify
```

To check backup status:
```bash
kyberbot backup status
```

## Restore on a New Machine

1. `git clone <your-repo-url>`
2. Install KyberBot CLI (`pnpm install -g @kyberbot/cli` or build from source)
3. Install Claude Code
4. Copy `.env` manually (not in git — contains API keys)
5. Copy `data/claude-memory/*.md` to `~/.claude/projects/<agent-path>/memory/`
6. `docker-compose up -d` (starts ChromaDB with existing data in `data/chromadb/`)
7. `kyberbot` — agent is fully restored

## Notes

- `.env` is never committed (contains secrets). Keep a secure copy separately.
- `identity.yaml` may contain channel tokens — keep the repo **private**.
- SQLite WAL checkpoint is critical — without it, recent writes won't be in the .db files.
- ChromaDB data is binary but typically small (~2MB). Git handles it fine at this scale.
