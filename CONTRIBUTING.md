# Contributing to KyberBot

Thank you for your interest in contributing to KyberBot. This guide will help you get set up and understand the project conventions.

---

## Getting Started

### 1. Fork and Clone

```bash
# Fork the repo on GitHub, then:
git clone https://github.com/YOUR_USERNAME/kyberbot.git
cd kyberbot
```

### 2. Install Dependencies

```bash
npm install
```

This installs dependencies for all packages in the monorepo (the root workspace, `packages/cli`, and `packages/create-kyberbot`).

### 3. Build

```bash
npm run build
```

This builds all packages. Each package compiles TypeScript to JavaScript in its `dist/` directory.

### 4. Run Locally

```bash
# Link the CLI globally for testing
cd packages/cli
npm link

# Now you can use the kyberbot command
kyberbot --help
```

---

## Project Structure

```
kyberbot/
├── packages/
│   ├── cli/                   # Main KyberBot CLI
│   │   ├── src/
│   │   │   ├── commands/      # CLI command handlers
│   │   │   ├── brain/         # Memory system (ChromaDB, SQLite, search)
│   │   │   │   └── sleep/     # Sleep agent (decay, tag, link, tier, summarize)
│   │   │   ├── server/        # HTTP server for webhooks/channels
│   │   │   ├── channels/      # Messaging integrations (Telegram, WhatsApp)
│   │   │   ├── config.ts      # Configuration management
│   │   │   ├── splash.ts      # ASCII splash screen
│   │   │   ├── types.ts       # Shared TypeScript types
│   │   │   └── index.ts       # CLI entry point
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── create-kyberbot/       # npx create-kyberbot scaffolder
│       ├── src/
│       │   └── index.ts       # Scaffolding logic
│       ├── package.json
│       └── tsconfig.json
│
├── template/                  # Template files for new agents
│   ├── SOUL.md                # Default personality template
│   ├── USER.md                # Default user profile template
│   ├── HEARTBEAT.md           # Default heartbeat tasks
│   └── CLAUDE.md              # Claude Code instructions
│
├── docs/                      # Documentation
├── package.json               # Root workspace config
├── tsconfig.base.json         # Shared TypeScript config
├── LICENSE                    # MIT license
└── README.md                  # Project overview
```

---

## Development Workflow

### Making Changes

1. Create a feature branch from `main`:

   ```bash
   git checkout -b feat/my-feature
   ```

2. Make your changes in the relevant package under `packages/`.

3. Build and verify:

   ```bash
   npm run build
   npm run typecheck
   npm run lint
   ```

4. Test your changes locally by running the CLI.

5. Commit with a clear message (see Commit Guidelines below).

6. Push and open a pull request against `main`.

### Running Type Checks

```bash
npm run typecheck
```

### Running the Linter

```bash
npm run lint
```

---

## Code Style

### TypeScript

- All source code is written in TypeScript.
- Strict mode is enabled (`"strict": true` in tsconfig).
- Use `interface` for object shapes and `type` for unions/intersections.
- Prefer `const` over `let`. Never use `var`.

### ESM (ES Modules)

- KyberBot uses ES modules throughout. All `import` statements must use `.js` extensions for local imports, even though the source files are `.ts`:

  ```typescript
  // Correct
  import { getConfig } from './config.js';
  import { SearchResult } from './types.js';

  // Incorrect
  import { getConfig } from './config';
  import { getConfig } from './config.ts';
  ```

- Use `import` / `export`, not `require()` / `module.exports`.

### File Naming

- Use kebab-case for filenames: `sleep-agent.ts`, `entity-graph.ts`
- Use PascalCase for classes and interfaces: `SleepAgent`, `EntityGraph`
- Use camelCase for functions and variables: `runDecayCycle`, `searchMemories`

### Error Handling

- Use explicit error types where possible.
- Always log errors with enough context to debug.
- Prefer `try/catch` over `.catch()` chains for async operations.

### Comments

- Use JSDoc comments for public functions and interfaces.
- Keep inline comments minimal -- the code should be self-explanatory.
- Use `// TODO:` for known improvements.

---

## Commit Guidelines

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add WhatsApp channel support
fix: prevent duplicate entity graph entries
docs: update brain architecture documentation
refactor: extract sleep cycle steps into separate modules
chore: update dependencies
```

### Scope (optional)

Use the package name as scope when the change is package-specific:

```
feat(cli): add timeline query command
fix(create-kyberbot): handle spaces in project path
```

---

## Pull Request Guidelines

### Before Submitting

- [ ] Code builds without errors (`npm run build`)
- [ ] Type check passes (`npm run typecheck`)
- [ ] Linter passes (`npm run lint`)
- [ ] Commit messages follow conventional commits
- [ ] New features include documentation updates

### PR Description

Include:

- **What** the PR does (1-2 sentences)
- **Why** the change is needed
- **How** to test it
- Any breaking changes or migration steps

### Review Process

- All PRs require at least one review before merging.
- Maintainers may request changes or suggest alternatives.
- Keep PRs focused -- one feature or fix per PR when possible.

---

## Adding a New Command

1. Create a new file in `packages/cli/src/commands/`:

   ```typescript
   // packages/cli/src/commands/my-command.ts
   import { Command } from '../types.js';

   export const myCommand: Command = {
     name: 'my-command',
     description: 'What this command does',
     async execute(args: string[]) {
       // Implementation
     }
   };
   ```

2. Register it in the command registry (see existing commands for the pattern).

3. Add documentation to `docs/` if it is a user-facing feature.

---

## Adding a New Channel

1. Create a new directory in `packages/cli/src/channels/`:

   ```
   packages/cli/src/channels/my-channel/
   ├── index.ts          # Channel implementation
   └── types.ts          # Channel-specific types
   ```

2. Implement the `Channel` interface (see `docs/channels.md` for the interface definition).

3. Register the channel in the service startup flow.

4. Add setup documentation.

---

## Questions?

Open a [GitHub Discussion](https://github.com/kyberbot/kyberbot/discussions) or file an issue. We are happy to help.
