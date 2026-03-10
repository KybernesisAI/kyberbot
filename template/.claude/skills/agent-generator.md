---
description: "Create a new sub-agent when a task needs a different perspective, persona, or isolated expertise. Use when someone says create an agent, build an agent, I need a specialist for, or make me an agent that. Also use when delegating work that benefits from a separate system prompt or persona."
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(kyberbot agent *)
---

# Agent Generator

You are the Agent Generator — the capability that allows this agent to create specialized sub-agents. Sub-agents are isolated sessions with their own system prompt, persona, and model.

## When to Create an Agent vs a Skill

**Create a SKILL when:**
- The task is a repeatable workflow (deploy, check status, generate report)
- The main agent follows the instructions directly
- No persona change is needed — same voice, same perspective
- It's a "how to do X" recipe

**Create an AGENT when:**
- A different perspective or persona is needed (code reviewer, security auditor, writing editor)
- Isolation is important — the task should run in its own context
- Domain expertise benefits from a separate system prompt (legal analyst, data scientist)
- The task produces structured findings that the main agent then acts on
- You want a "second opinion" or adversarial review

**Rule of thumb:** Skills are instructions you follow. Agents are specialists you delegate to.

## Process

### Step 1: Analyze the Need

Determine:
- What perspective or expertise is needed?
- What should the agent's persona be?
- What tools does it need access to?
- What model is appropriate? (haiku for fast/simple, sonnet for balanced, opus for complex reasoning — default is opus)
- How many turns might it need?

### Step 2: Scaffold the Agent

```bash
kyberbot agent create <name> -d "<description>" -r "<role>" -m <model> -t <max-turns>
```

Example:
```bash
kyberbot agent create code-reviewer -d "Reviews code for bugs, patterns, and best practices" -r "A thorough, constructively critical code reviewer" -m opus -t 10
```

### Step 3: Edit the Agent Definition

Open `.claude/agents/<name>.md` and customize:
- The **Scope** section — define exactly what the agent focuses on
- The **How You Work** section — specific methodology for this domain
- The **Output Format** — what structure findings should take
- The **Constraints** — boundaries and limitations

### Step 4: Register and Test

Rebuild CLAUDE.md so the agent appears in the operational manual:

```bash
kyberbot agent rebuild
```

Test the agent with a sample prompt:

```bash
kyberbot agent spawn <name> "<test prompt>"
```

### Step 5: Confirm

After verifying the agent works:
1. Report to the user: "I've created a new agent: [name]. I can now delegate [type of work] to it."
2. If applicable, use the agent to handle the original task

## Agent Naming Convention

- Use lowercase kebab-case: `code-reviewer`, `security-auditor`
- Be descriptive but concise
- Prefix with domain if applicable: `frontend-reviewer`, `api-tester`

## Quality Standards

Every generated agent must:
1. Have a clear `description` that explains when to use it
2. Have a specific `role` that defines the persona
3. Specify appropriate `allowed-tools`
4. Choose the right `model` for the complexity level
5. Have a well-defined scope and output format

## Template Location

Reference template at `.claude/agents/templates/agent-template.md`
