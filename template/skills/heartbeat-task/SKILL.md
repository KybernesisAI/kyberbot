---
name: heartbeat-task
description: "Add, update, or remove recurring tasks in HEARTBEAT.md. Use when the user says remind me to, check every, run daily, do this weekly, every morning, schedule a recurring, set up a check for, or describes any task that should happen on a regular cadence."
allowed-tools: Read, Edit
---

# Heartbeat Task

Manages recurring tasks in HEARTBEAT.md — the agent's standing instruction file. The heartbeat service checks this file at a regular interval and executes the most overdue task each cycle.

## When to Fire

Fire this skill whenever the user describes something that should happen regularly. Listen for:

**Add a task when the user says:**
- "Remind me to check X every morning"
- "Every Monday, review the sprint board"
- "Check my email every 4 hours"
- "Run the test suite daily at 9am"
- "Keep an eye on the deployment pipeline"
- "Weekly, summarize what happened this week"
- Any instruction with time-based recurrence (every, daily, weekly, hourly, morning, evening)

**Update a task when:**
- The user changes the cadence ("make that every 2 hours instead")
- The user refines what the task should do
- The user changes the time window

**Remove a task when:**
- The user says "stop checking...", "cancel the...", "remove the..."
- A task is no longer relevant

## HEARTBEAT.md Format

Tasks in HEARTBEAT.md follow this exact structure:

```markdown
### Task Name
**Schedule**: every 4h / daily 9am / weekly Monday / every 30m
**Window**: 09:00-17:00 (optional — restricts execution to these hours)
**Action**: What the agent should do — written as a clear instruction
```

The schedule field uses natural language that the heartbeat parser understands:
- `every 30m` / `every 2h` / `every 4h` — interval-based
- `daily 9am` / `daily` — once per day
- `weekly Monday` / `weekly` — once per week

The window field is optional — omit it if the task can run anytime during active hours.

## Implementation

### Adding a Task

1. Read the current HEARTBEAT.md
2. Add a new task section under `## Tasks` using the format above
3. Choose a clear, descriptive task name
4. Write the action as a specific instruction the agent can follow autonomously
5. Confirm to the user what was added

### Updating a Task

1. Read HEARTBEAT.md
2. Find the matching task section
3. Edit the relevant fields (schedule, window, or action)
4. Confirm the change

### Removing a Task

1. Read HEARTBEAT.md
2. Find and remove the entire task section (### through the last field)
3. Confirm removal

## Examples

**User says:** "Every morning, check if there are any new issues on the GitHub repo"
```markdown
### Check GitHub Issues
**Schedule**: daily 9am
**Action**: Run `gh issue list --state open --limit 10` on the main repo. If there are new issues since yesterday, summarize them and note any urgent ones.
```

**User says:** "Remind me to review my todo list every 4 hours"
```markdown
### Review Todo List
**Schedule**: every 4h
**Window**: 09:00-18:00
**Action**: Read the current todo list and surface any items that are overdue or due soon. Remind the user of top priorities.
```

**User says:** "Every Friday, write a weekly summary"
```markdown
### Weekly Summary
**Schedule**: weekly Friday
**Action**: Query the timeline for this week's events with `kyberbot timeline --week`. Summarize key decisions, people met, and progress made. Write the summary to brain/weekly-summaries/.
```

## Notes

- The heartbeat service runs the most overdue task each cycle — it doesn't run all tasks at once.
- Tasks should be written as instructions the agent can execute autonomously, without user input.
- Keep actions specific. "Check email" is vague. "Run `command` and summarize new items" is actionable.
- The heartbeat respects active hours configured in identity.yaml — tasks won't run outside those hours regardless of their schedule.
