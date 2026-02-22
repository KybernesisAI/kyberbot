# Skills

Skills are reusable capabilities that extend what your KyberBot agent can do. They are markdown files with structured metadata that the agent loads and follows when a matching task is requested.

---

## Overview

Skills solve a simple problem: Claude Code is incredibly capable, but it does not know your specific workflows. A skill file teaches the agent _how_ to perform a task the way you want it done, every time.

**Examples of skills:**

- Track running mileage and calculate weekly totals
- Generate a weekly report from GitHub activity
- Parse bank statements and categorize expenses
- Draft emails in your writing style
- Manage a reading list with notes and ratings

---

## SKILL.md Format

Every skill lives in its own directory under `skills/` and contains a `SKILL.md` file with YAML frontmatter and natural language instructions.

```
skills/
├── my-skill/
│   └── SKILL.md
├── weekly-report/
│   └── SKILL.md
└── water-tracker/
    └── SKILL.md
```

```markdown
---
name: skill-name
description: One-line description of what this skill does
version: 1.0.0
requires_env: []
has_setup: false
---

# Skill Name

## What This Does

A brief explanation of what this skill accomplishes and when it should be used.

## How to Use

- "trigger phrase one"
- "trigger phrase two"
- "trigger phrase three"

## Implementation

Step-by-step instructions the agent follows when executing this skill.

1. First step
2. Second step
3. Third step
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique identifier (kebab-case) |
| `description` | Yes | One-line summary |
| `version` | No | Semver version (default: 1.0.0) |
| `requires_env` | No | Environment variables the skill needs |
| `has_setup` | No | Whether the skill has a setup script |

---

## Creating Skills

### Via CLI

```bash
kyberbot skill create my-skill
```

This scaffolds a new skill directory:

```
Creating skill: my-skill
  skills/my-skill/SKILL.md created

Edit the SKILL.md file to add your instructions.
```

Options:

```bash
kyberbot skill create my-skill -d "Track weekly running mileage"
kyberbot skill create my-skill --env STRAVA_TOKEN --setup
```

### Manually

1. Create a directory and SKILL.md file:

   ```bash
   mkdir -p skills/my-skill
   touch skills/my-skill/SKILL.md
   ```

2. Write the skill following the SKILL.md format above.

3. Run `kyberbot skill rebuild` to update CLAUDE.md with the new skill.

### Agent Auto-Generation

The most powerful way to create skills is to let the agent do it. When you ask the agent to perform a task and no existing skill matches:

1. The agent recognizes the gap
2. It generates a skill file
3. It writes the skill to `skills/<name>/SKILL.md`
4. It executes the task immediately
5. The skill is available for all future sessions

**Example conversation:**

```
You: Track my water intake. I want to log glasses of water
     and see daily totals.

Agent: I don't have a skill for water tracking yet. Let me
       create one.

       [Creates skills/water-tracker/SKILL.md]

       Done. I've created a water tracking skill. Let me log
       your first entry -- how many glasses have you had today?
```

---

## Skill Lifecycle Commands

```bash
# List all installed skills
kyberbot skill list

# Show details of a specific skill
kyberbot skill info <name>

# Create a new skill
kyberbot skill create <name>

# Remove a skill
kyberbot skill remove <name>

# Run skill setup (if the skill has setup requirements)
kyberbot skill setup <name>

# Rebuild CLAUDE.md with current skills
kyberbot skill rebuild
```

### Example Output

```bash
$ kyberbot skill list

  Skills

  NAME              VERSION  DESCRIPTION
  morning-briefing  1.0.0    Compile a morning briefing from all sources
  weekly-report     1.0.0    Generate a weekly summary of completed work
  water-tracker     1.0.0    Track daily water intake
```

---

## Skill Generator

The skill generator is the mechanism the agent uses to create skills autonomously. It follows a consistent process:

### Generation Process

1. **Assess** -- Is this task feasible with available tools? If the task requires an API the agent cannot access or hardware it does not have, it tells you instead of generating a broken skill.

2. **Research** -- The agent determines the best approach. What tools are needed? What data format? Where should results be stored?

3. **Generate** -- The agent writes the skill directory and SKILL.md file with complete metadata and instructions.

4. **Validate** -- The agent reads back the skill to verify it is well-formed and complete.

5. **Execute** -- The agent immediately uses the new skill to complete the original task.

6. **Persist** -- The skill file is saved and CLAUDE.md is rebuilt to include it.

### Improving Generated Skills

Generated skills are starting points. You can:

- Edit the SKILL.md to refine instructions
- Ask the agent to improve a skill: "Make the water-tracker skill also track the time of each entry"
- Add setup scripts or environment variable requirements

---

## Skill Design Tips

### Be Specific

Bad:
```markdown
## Implementation
Help the user track expenses.
```

Good:
```markdown
## Implementation
1. When the user logs an expense, extract: amount, category, date, description
2. Categories: food, transport, housing, health, entertainment, other
3. Store in brain with tag "expense" and the category as a second tag
4. When queried for totals, group by category and show amounts
5. Compare against monthly budget if defined in USER.md
```

### Use Trigger Phrases Thoughtfully

The "How to Use" section shows trigger phrases that help the agent match user messages to skills. Use natural phrases that a user would actually say. Include variations:

```markdown
## How to Use

- "log a run"
- "I went running"
- "running mileage"
- "how far did I run"
- "track my run"
```

### Keep Skills Focused

One skill should do one thing well. If a skill is trying to handle too many cases, split it into multiple skills.
