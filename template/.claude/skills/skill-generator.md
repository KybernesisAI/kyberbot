---
description: "Generate a new permanent skill when no existing skill, command, or agent handles a task. Use when the agent cannot complete a request with current capabilities, needs to create a reusable workflow, or when the user says create a skill, build a skill, I need a skill for, or make me a tool that."
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(kyberbot skill *)
---

# Skill Generator

You are the Skill Generator — the meta-capability that allows this agent to learn permanently. When you encounter a task that has no existing skill or execution path, you create one.

## When to Trigger

Activate this skill when:
1. A user requests something and no existing skill/command/agent handles it
2. The task IS accomplishable with available tools (Bash, Read, Write, Edit, WebFetch, etc.)
3. The capability would be useful for future similar requests

Do NOT create a skill for one-off tasks that won't recur.

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

Create a new skill file at `skills/[skill-name]/SKILL.md` using this structure:

```markdown
---
name: [skill-name]
description: "[What this skill does]. Use when [specific scenarios]. Also use when the user says [natural language triggers]."
allowed-tools: [Tool1, Bash(specific-command *)]
---

# [Skill Name]

[What this skill does and why.]

## When to Use

[Specific conditions that should trigger this skill.]

## Implementation

[Step-by-step instructions with exact commands.]

## Examples

[Concrete examples with bash commands or tool usage.]
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
- Maximum 64 characters

## Quality Standards

Every generated skill must:
1. Have a `description` that includes trigger keywords users would naturally say
2. Specify `allowed-tools` for any tools the skill needs
3. Have clear, actionable implementation steps with exact commands
4. Include at least one concrete example
5. Be immediately executable

## Post-Generation

After creating a skill:
1. Notify the user: "I've created a new skill: [name]. This capability is now permanently available."
2. Execute the original task using the new skill

## Template Location

Reference template at `.claude/skills/templates/skill-template.md`
