---
name: heartbeat-task
description: "Add, update, or remove recurring tasks in HEARTBEAT.md. Use when the user says remind me to, check every, run daily, do this weekly, every morning, schedule a recurring, set up a check for, or describes any task that should happen on a regular cadence."
allowed-tools: Read, Edit, Write, Glob, Bash(kyberbot *)
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

## Setup Workflow — Follow Every Time

When creating a new recurring task, always walk through these steps in order. Do not skip any.

### 1. Clarify the Task

Make sure you understand exactly what should happen:
- What is being checked, queried, or produced?
- What service or API is involved (if any)?
- How often should it run?
- Should it only run during certain hours?

If anything is ambiguous, ask the user before proceeding.

### 2. Resolve Notification Delivery

Ask the user: **"Where do you want to receive the results?"**

Options to present:
- **Telegram** — send results as a Telegram message (if Telegram is configured in identity.yaml)
- **Brain only** — store in memory, viewable via `kyberbot recall` / `kyberbot timeline` (silent, no notification)
- **Brain file** — write results to a file in `brain/` for later review
- **Other** — the user may want Slack, email, Notion, etc. — this may require creating an integration

Read identity.yaml to check which channels are configured before presenting options. Don't offer Telegram if it's not set up.

### 3. Resolve Credentials & Dependencies

If the task requires API access:
- Check if the needed API key / token is already in `.env`
- If not, walk the user through getting it (where to find it, what permissions it needs)
- Store it in `.env` (tell the user what you're adding)
- Note the env var name — the skill will reference it

If the task requires a CLI tool, package, or external service:
- Check if it's available
- Walk through installation if needed

### 4. Create a Skill (for non-trivial tasks)

If the task involves more than a single simple command (API calls, parsing output, conditional notifications), create a dedicated skill:

1. Create `skills/<task-name>/SKILL.md`
2. Include the full step-by-step execution instructions
3. Include the notification delivery method chosen in step 2
4. Reference env vars by name (e.g., `$POSTHOG_API_KEY`), never hardcode secrets
5. If Telegram delivery was chosen, include the curl command to send the message using the bot token and chat ID from identity.yaml

### 5. Register the Heartbeat Task

Add the task to HEARTBEAT.md using the format below. If you created a skill in step 4, include the `**Skill**` reference.

### 6. Test It

Run the task once manually to verify it works:
- If you created a skill, follow its instructions step by step
- Verify the API call succeeds
- Verify the notification is delivered to the right place
- Fix any issues before confirming to the user

### 7. Confirm to the User

Tell the user:
- What task was created and its schedule
- Where results will be delivered
- That it's been tested and is working
- How to check on it later (`kyberbot heartbeat status`)

## HEARTBEAT.md Format

Tasks in HEARTBEAT.md follow this exact structure:

```markdown
### Task Name
**Schedule**: every 4h / daily 9am / weekly Monday / every 30m
**Window**: 09:00-17:00 (optional — restricts execution to these hours)
**Action**: What the agent should do — written as a clear instruction
**Skill**: skill-name (optional — references a skill in skills/ with detailed execution steps)
```

The schedule field uses natural language that the heartbeat parser understands:
- `every 30m` / `every 2h` / `every 4h` — interval-based
- `daily 9am` / `daily` — once per day
- `weekly Monday` / `weekly` — once per week

The window field is optional — omit it if the task can run anytime during active hours.

The **Skill** field is optional. When present, the heartbeat service automatically loads the full skill content from `skills/<skill-name>/SKILL.md` and injects it into the execution prompt. Use this when a task requires detailed, multi-step instructions that would be too verbose for the Action field alone.

## Examples

**Simple task (no skill needed):**
```markdown
### Review Todo List
**Schedule**: every 4h
**Window**: 09:00-18:00
**Action**: Read the current todo list and surface any items that are overdue or due soon. Remind the user of top priorities.
```

**Complex task with skill and Telegram delivery:**
```markdown
### PostHog Signup Check
**Schedule**: every 30m
**Action**: Check for new signups and notify via Telegram if any found.
**Skill**: posthog-signups
```

**Task with brain-only storage:**
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
- For Telegram delivery: read the bot token and owner_chat_id from identity.yaml at execution time. Never hardcode them in skill files.
