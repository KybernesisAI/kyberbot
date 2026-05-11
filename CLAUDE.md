# KyberBot — Development Guide

This file is for Claude Code instances working **on** KyberBot itself (not for end-user agents). For end-user agent instructions, see `template/.claude/CLAUDE.md` — that's what ships into a user's agent directory on `kyberbot onboard`.

## What KyberBot Is

An open-source personal AI agent that runs on top of Claude Code. The `kyberbot` CLI is a long-running local server that gives a Claude Code instance:

- Persistent memory (SQLite entity graph + timeline + ChromaDB vectors)
- A heartbeat scheduler for recurring tasks (`HEARTBEAT.md`)
- A sleep agent that maintains memory quality in the background
- Messaging channels (Telegram, WhatsApp)
- Auto-generated skills, sub-agents, and inter-agent (fleet) communication
- Living identity documents (`SOUL.md`, `USER.md`)

The CLI invokes Claude via the Agent SDK (`@anthropic-ai/claude-code`) by default, with subprocess fallback.

## This Repo and `kyberbot-desktop/` Are One Product

KyberBot the user-facing product is two repos developed together:

- **`kyberbot/`** (this repo) — the CLI, local server, brain, channels, skills, sleep agent. The engine.
- **`kyberbot-desktop/`** (`/Users/ianwinscom/kyb/kyberbot-desktop`) — the Electron control panel that spawns and supervises CLI processes. The shell.

They're versioned and shipped independently but routinely change together. Touching the CLI's HTTP API or process lifecycle without checking the desktop will break the desktop. Read `kyberbot-desktop/CLAUDE.md` before making changes that cross the boundary.

**How they connect:**

- Desktop's `LifecycleManager` (`kyberbot-desktop/src/main/lifecycle.ts`) spawns `kyberbot` as a child process per agent root, supports per-agent and shared "fleet" modes
- The renderer talks to each running CLI over HTTP at `localhost:3456` (so `webSecurity: false` in the Electron BrowserWindow)
- Health, status, and logs flow back through Electron IPC events (`SERVICES_HEALTH_UPDATE`, etc. — channels defined in `kyberbot-desktop/src/types/ipc.ts`)
- Desktop resolves the CLI from `~/.kyberbot/source/packages/cli/dist/index.js` first, then `pnpm link` locations, then `PATH`

**When changing the CLI side of the contract:**

- HTTP API changes — grep `kyberbot-desktop/src/renderer/` and `kyberbot-desktop/src/main/ipc/` for callers
- CLI command surface (rename/remove a command) — check `lifecycle.ts` spawn args, especially `fleet start --only` and the per-agent `run` invocation
- Startup output, log format, health-check endpoints — desktop parses these to drive UI status

Coordinated releases: desktop pins implicit shapes from the CLI; bump both versions when crossing the contract.

## Repo Layout

```
kyberbot/
├── packages/
│   ├── cli/                 @kyberbot/cli — the CLI + local server (main package)
│   │   └── src/
│   │       ├── index.ts     entry point
│   │       ├── commands/    Commander.js command handlers (~26 commands)
│   │       ├── server/      Express HTTP server (brain-api, chat-sse, bus-api, ...)
│   │       │   └── channels/  Telegram, WhatsApp bridges
│   │       ├── brain/       Memory: entity graph, timeline, semantic search, sleep agent
│   │       ├── runtime/     Claude invocation modes (Agent SDK / SDK / subprocess)
│   │       ├── orchestration/  Fleet & inter-agent coordination
│   │       ├── agents/      Sub-agent management
│   │       ├── skills/      Skill registry & generation
│   │       └── services/    Service lifecycle (heartbeat, sleep, channels)
│   ├── create-kyberbot/     `npx create-kyberbot` scaffolder
│   └── web/                 React/Vite in-browser UI (separate from desktop)
├── template/                Copied into a new agent's dir on `kyberbot onboard`
│   ├── SOUL.md, USER.md, HEARTBEAT.md, identity.yaml
│   └── .claude/CLAUDE.md    The end-user agent's operating manual
├── docs/                    User-facing docs (architecture, brain, channels, ...)
└── .als/                    Internal job-pipeline tooling — DO NOT EDIT MANUALLY
```

## Dev Workflow

**Use `pnpm`, not npm.** The root specifies `pnpm@>=9` and uses `pnpm` workspaces. (CONTRIBUTING.md still says npm in places — it's stale.)

```bash
pnpm install          # install all workspaces
pnpm build            # build all packages (recursive: pnpm -r run build)
pnpm typecheck        # tsc --noEmit on packages/cli
pnpm lint             # eslint
pnpm test             # vitest watch
pnpm test:run         # vitest single run

# Link the CLI for local testing (one-time)
cd packages/cli && pnpm link --global

# CLI dev mode (watch tsc rebuild)
cd packages/cli && pnpm dev
```

To test a CLI change end-to-end: `pnpm build`, then run `kyberbot` in a separate test agent directory (e.g. `~/kyberbot-test/`).

To test desktop integration: `pnpm build` here, then `pnpm dev` in `kyberbot-desktop/` (it'll spawn the linked CLI).

### Branch & Commit Conventions

- Branch off `main`: `feat/...`, `fix/...`, `chore/...`, `refactor/...`
- Conventional commits with optional package scope: `feat(cli): add ...`, `fix(desktop): ...`
- Before opening a PR: build, typecheck, and lint must pass

## Code Conventions

- **TypeScript strict mode**, ESM throughout
- **Local imports must use `.js` extensions** even when the source is `.ts`:
  ```ts
  import { getConfig } from './config.js';   // correct
  import { getConfig } from './config';      // wrong
  ```
- File naming: kebab-case (`sleep-agent.ts`); classes/interfaces PascalCase; functions/vars camelCase
- Default to no comments. Add one only when the *why* is non-obvious. Don't write JSDoc for self-explanatory functions.
- Don't add error handling, fallbacks, or validation for impossible scenarios. Trust internal callers; validate at boundaries (HTTP input, channel input, user CLI args).

## Things to Know

### `.als/` is generated, don't hand-edit
The `.als/` directory is managed by an internal authoring system. Its `CLAUDE.md` says so explicitly. Changes go through ALS skills (`/new`, `/change`, `/migrate`, `/validate`). Treat it as build output for our purposes.

### `template/` ships to end users
Anything in `template/` is copied into a fresh agent directory on `kyberbot onboard` and refreshed on `kyberbot update`. **Do not put dev-time content there.** `template/.claude/CLAUDE.md` is the operating manual the end-user agent reads — edits affect every agent created or updated after the change.

### Three Claude invocation modes
`packages/cli/src/runtime/` implements:
1. **Agent SDK** (default) — `@anthropic-ai/claude-code` `query()`, no API key needed
2. **SDK** — direct `@anthropic-ai/sdk`, requires `ANTHROPIC_API_KEY`
3. **Subprocess** — fallback, spawns `claude -p`

Mode is selected at startup based on `identity.yaml` and what's importable.

### Brain has three layers
- Entity graph (libsql/SQLite) — structured facts, people, projects, relationships
- Timeline (SQLite) — temporal event index
- Semantic search (ChromaDB) — vector embeddings

The sleep agent (`brain/sleep/`) runs hourly: decay → tag → link → tier → summarize → entity hygiene.

### Server endpoints
`packages/cli/src/server/` exposes the HTTP API on port 3456. Key files: `brain-api.ts`, `chat-sse.ts`, `bus-api.ts`, `execute-api.ts`, `management-api.ts`, `orchestration-api.ts`, `web-api.ts`. Each has a corresponding `*.test.ts`.

## Reference Docs

- `CONTRIBUTING.md` — contributor onboarding (npm references are stale; use pnpm)
- `docs/architecture.md` — three-mode architecture, data flows, file structure
- `docs/brain.md` — memory subsystem detail
- `docs/channels.md` — Telegram/WhatsApp channel interface
- `docs/cli-reference.md` — full CLI command surface
- `docs/skills.md` — skill system
- `template/.claude/CLAUDE.md` — what end-user agents see
