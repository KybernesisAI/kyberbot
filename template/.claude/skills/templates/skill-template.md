---
name: [skill-name]
description: "[What this skill does]. Use when [specific scenarios and triggers]. Also use when the user says [natural language phrases users would say]."
allowed-tools: Tool1 Tool2 Bash(specific-command:*)
metadata:
  version: "0.1.0"
---

<!--
NOTE TO SKILL AUTHORS — DELETE THIS BLOCK BEFORE SAVING.
Frontmatter follows the agentskills.io spec (https://agentskills.io/specification):
  - name: max 64 chars, lowercase + digits + hyphens only, must match parent dir, no leading/trailing hyphen, no `--`
  - description: max 1024 chars, what + when (include trigger phrases)
  - allowed-tools: SPACE-separated (not comma). Use colon-form for Bash patterns: Bash(git:*) Bash(jq:*)
  - metadata: arbitrary key-value map. Put non-spec fields (version, requires_env, has_setup) HERE, not at top level.
  - compatibility (optional): env requirements — git, Python, MCPs, network access, etc.
  - license (optional): license name or filename
Validate with: npx skills-ref validate ./<skill-name>
-->


# [Skill Name]

[2-3 sentence description of what this skill accomplishes and why it's useful.]

## When to Use

[Describe the conditions under which this skill should fire. Be specific about what signals in the conversation should trigger invocation.]

## Implementation

### Step 1: [Gather Information]

[What information needs to be collected before proceeding]

### Step 2: [Core Action]

[The main action this skill performs — include exact commands or tool usage]

### Step 3: [Verify & Report]

[How to verify success and what to report to the user]

## Examples

**[Scenario 1]:** [Brief situation description]
```bash
[exact command or action]
```

**[Scenario 2]:** [Brief situation description]
```bash
[exact command or action]
```

## Notes

- [Important consideration]
- [Limitation or caveat]
