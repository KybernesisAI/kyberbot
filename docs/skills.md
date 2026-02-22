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

Every skill is a markdown file with YAML frontmatter and natural language instructions.

```markdown
---
name: skill-name
description: One-line description of what this skill does
version: 1
triggers:
  - "trigger phrase one"
  - "trigger phrase two"
  - "trigger phrase three"
tools:
  - bash
  - read
  - write
  - web-search
author: auto | manual
created: 2026-02-22
---

# Skill Name

## Purpose

A brief explanation of what this skill accomplishes and when it should be used.

## Instructions

Step-by-step instructions the agent follows when executing this skill.

1. First step
2. Second step
3. Third step

## Input

What information the agent needs from the user to execute this skill.

- Required: description of required input
- Optional: description of optional input

## Output

What the agent produces when this skill runs.

- Format and structure of the output
- Where results are stored (brain, file, response)

## Examples

### Example 1: [scenario]

**User:** "example user message"

**Agent:** example agent response or action
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique identifier (kebab-case) |
| `description` | Yes | One-line summary |
| `version` | No | Version number (default: 1) |
| `triggers` | Yes | Phrases that activate this skill |
| `tools` | No | Tools the skill requires (for documentation) |
| `author` | No | `auto` (agent-generated) or `manual` (human-written) |
| `created` | No | ISO date of creation |

---

## Creating Skills

### Manually

1. Create a markdown file in `skills/`:

   ```bash
   touch skills/my-skill.md
   ```

2. Write the skill following the SKILL.md format above.

3. The agent discovers it on next session start.

### Via CLI

```bash
kyberbot skills create
```

This starts an interactive wizard:

```
Skill name: weekly-report
Description: Generate a weekly summary of completed work
Triggers (comma-separated): weekly report, what did I do this week, week summary

Creating skills/weekly-report.md...

Edit the file to add detailed instructions, then the skill is ready.
```

### Agent Auto-Generation

The most powerful way to create skills is to let the agent do it. When you ask the agent to perform a task and no existing skill matches:

1. The agent recognizes the gap
2. It generates a skill file based on the conversation
3. It writes the skill to `skills/generated/`
4. It executes the task immediately
5. The skill is available for all future sessions

**Example conversation:**

```
You: Track my water intake. I want to log glasses of water
     and see daily totals.

Agent: I don't have a skill for water tracking yet. Let me
       create one.

       [Creates skills/generated/water-tracker.md]

       Done. I've created a water tracking skill. Let me log
       your first entry -- how many glasses have you had today?
```

---

## Skill Lifecycle Commands

```bash
# List all installed skills
kyberbot skills list

# Show details of a specific skill
kyberbot skills show <name>

# Create a new skill interactively
kyberbot skills create

# Remove a skill
kyberbot skills remove <name>

# Run skill setup (if the skill has setup requirements)
kyberbot skills setup <name>
```

### Example Output

```bash
$ kyberbot skills list

  Skills (6 installed)

  NAME              TYPE    TRIGGERS
  morning-briefing  manual  "morning briefing", "start my day"
  weekly-report     manual  "weekly report", "week summary"
  water-tracker     auto    "log water", "water intake"
  run-tracker       auto    "log a run", "running mileage"
  email-drafter     auto    "draft email", "write email"
  expense-tracker   auto    "log expense", "categorize spending"
```

---

## Skill Generator

The skill generator is the mechanism the agent uses to create skills autonomously. It follows a consistent process:

### Generation Process

1. **Assess** -- Is this task feasible with available tools? If the task requires an API the agent cannot access or hardware it does not have, it tells you instead of generating a broken skill.

2. **Research** -- The agent determines the best approach. What tools are needed? What data format? Where should results be stored?

3. **Generate** -- The agent writes the skill file with complete metadata and instructions.

4. **Validate** -- The agent reads back the skill to verify it is well-formed and complete.

5. **Execute** -- The agent immediately uses the new skill to complete the original task.

6. **Persist** -- The skill file is saved to `skills/generated/` and committed via git auto-sync.

### Generated Skill Location

- Manual skills: `skills/`
- Auto-generated skills: `skills/generated/`

This separation makes it easy to see which skills you wrote and which the agent created.

### Improving Generated Skills

Generated skills are starting points. You can:

- Edit them to refine instructions
- Move them from `skills/generated/` to `skills/` to promote them
- Ask the agent to improve a skill: "Make the water-tracker skill also track the time of each entry"

---

## Skill Design Tips

### Be Specific

Bad:
```markdown
## Instructions
Help the user track expenses.
```

Good:
```markdown
## Instructions
1. When the user logs an expense, extract: amount, category, date, description
2. Categories: food, transport, housing, health, entertainment, other
3. Store in brain with tag "expense" and the category as a second tag
4. When queried for totals, group by category and show amounts
5. Compare against monthly budget if defined in USER.md
```

### Define Input and Output

Skills work best when the agent knows exactly what to expect and what to produce. Define the input format and output format explicitly.

### Use Triggers Thoughtfully

Triggers are how the agent matches user messages to skills. Use natural phrases that a user would actually say. Include variations:

```yaml
triggers:
  - "log a run"
  - "I went running"
  - "running mileage"
  - "how far did I run"
  - "track my run"
```

### Keep Skills Focused

One skill should do one thing well. If a skill is trying to handle too many cases, split it into multiple skills.
