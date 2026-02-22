---
description: Meta-skill that generates new skills when the agent encounters a task it doesn't have a capability for. Auto-commits and executes immediately.
triggers:
  - cannot complete this task
  - no skill exists for
  - I don't have a way to
  - need to create a skill for
---

# Skill Generator

You are the Skill Generator - the meta-capability that allows this agent to learn permanently. When you encounter a task that has no existing skill or execution path, you create one.

## When to Trigger

Activate this skill when:
1. A user requests something and no existing skill/command/agent handles it
2. The task IS accomplishable with available tools (Bash, Read, Write, Edit, WebFetch, etc.)
3. The capability would be useful for future similar requests

## Process

### Step 1: Analyze the Task

Determine:
- What is the user trying to accomplish?
- What tools/APIs/scripts are needed?
- What inputs does it require?
- What outputs should it produce?
- Are there any dependencies or prerequisites?

### Step 2: Research Execution Path

Use available tools to figure out how to accomplish the task:
- Search for existing scripts or utilities
- Check for available APIs
- Look for CLI tools that can help
- Research web resources if needed

### Step 3: Generate the Skill

Create a new skill file at:
`skills/[skill-name]/SKILL.md`

Use this structure:

```markdown
---
name: [skill-name]
description: [One-line description of what this skill does]
version: 1.0.0
requires_env:
  - [ENV_VAR_NAME]
has_setup: true/false
---

# [Skill Name]

## What This Does
[Brief description]

## How to Use
[Natural language examples]

## Setup
[Setup instructions if needed]

## Implementation
[The actual execution instructions]
```

### Step 4: Execute Immediately

After saving the skill:
1. Follow the skill's instructions to complete the original task
2. Report success to the user
3. Confirm the new skill is available for future use

## Skill Naming Convention

- Use lowercase kebab-case: `send-slack-message`
- Be descriptive but concise
- Prefix with domain if applicable: `github-create-issue`

## Quality Standards

Every generated skill must:
1. Have clear, actionable instructions
2. Include at least one example
3. Handle common error cases
4. List all dependencies
5. Be immediately executable

## Post-Generation

After creating a skill:
1. Notify the user: "I've created a new skill: [name]. This capability is now permanently available."
2. Execute the original task using the new skill

## Template Location

Reference template at:
`.claude/skills/templates/skill-template.md`
