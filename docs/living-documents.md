# Living Documents

KyberBot agents maintain three living documents that define their identity, knowledge, and routine. These files are read by Claude Code at session start and updated by the agent as it learns and adapts.

---

## SOUL.md -- Agent Personality

SOUL.md defines who the agent is: its personality, values, communication style, and beliefs about how it should operate.

### Format

```markdown
# [Agent Name]

## Identity

A brief description of who this agent is and its relationship to the user.

## Values

- Value 1: Explanation
- Value 2: Explanation
- Value 3: Explanation

## Communication Style

How the agent should communicate. Tone, formatting preferences,
verbosity level, when to be proactive vs reactive.

## Beliefs

What the agent believes about its role, its purpose, and how it
should approach problems.

## Boundaries

What the agent should NOT do. Topics to avoid, behaviors to
refrain from, limits on autonomy.
```

### How the Agent Updates It

The agent updates SOUL.md when:

- You give explicit feedback about communication ("Be more concise", "Use bullet points")
- The agent notices consistent patterns in your preferences
- During self-reflection tasks (evening reviews, weekly reviews)
- You directly ask the agent to change its personality

The agent typically adds detail and nuance over time. Early SOUL.md files are broad; mature ones are specific and battle-tested.

### Example

**Day 1:**

```markdown
## Communication Style

Be helpful and clear. Ask clarifying questions when uncertain.
```

**Day 60:**

```markdown
## Communication Style

- Lead with the answer. Context comes after.
- Use bullet points for any list of 3+ items.
- Code examples over prose when explaining technical concepts.
- Never say "Great question!" or use filler phrases.
- When uncertain, say "I'm not sure" -- do not hedge or qualify.
- Morning briefings: max 10 bullet points, sorted by priority.
- Evening reviews: ask 3 reflective questions, then summarize.
- Default to action ("Here's the draft") over permission ("Would you like me to...").
```

---

## USER.md -- User Knowledge

USER.md is the agent's accumulated knowledge about you. It grows continuously as the agent learns new information through conversation.

### Format

```markdown
# About [User Name]

## Profile

Name, location, timezone, occupation, etc.

## Work

Current role, projects, team, tools, goals.

## Health

Tracking systems, routines, goals, conditions.

## Interests

Hobbies, topics of interest, content preferences.

## Family

Family members, relationships, relevant context.

## Preferences

Communication preferences, tool preferences, scheduling preferences.

## Goals

Short-term and long-term goals, with timelines if known.

## Projects

Active projects with status, stack, and next steps.

## Routines

Daily, weekly, and monthly routines.
```

### How the Agent Updates It

The agent appends to USER.md when you share new information. It organizes facts into the appropriate section. If information changes (e.g., you switch jobs), it updates the relevant section.

**Key principles:**

- The agent never deletes information without being asked
- New facts are added to the most relevant section
- Conflicting information is flagged and confirmed before overwriting
- Sensitive information (passwords, financial details) is never stored in USER.md

### Example Growth

**Week 1:**

```markdown
## Work

Software engineer. Building a SaaS product. Uses TypeScript and Next.js.
```

**Week 8:**

```markdown
## Work

### Current Role
Senior engineer at a fintech startup (Series A, 12 people).

### Active Projects
- **PayFlow** -- Payment processing dashboard. Next.js 15, Supabase, Stripe.
  Target launch: June 15. Current status: Beta testing with 3 pilot customers.
- **Internal Tools** -- Admin dashboard for ops team. Low priority.

### Tech Stack
TypeScript, Next.js 15, React 19, Supabase, Tailwind CSS, Vercel.
Prefers Cursor for IDE, Claude Code for CLI.

### Team
- Sarah (PM) -- Manages sprint planning. Prefers Slack over email.
- Marcus (design) -- Figma files in shared workspace.
- Priya (backend) -- Handles Stripe integration.

### Work Patterns
- Deep work: 9-12 AM (no meetings)
- Standup: 12:30 PM daily
- Sprint planning: Monday 2 PM
- Prefers async communication for non-urgent items
```

---

## HEARTBEAT.md -- Recurring Tasks

HEARTBEAT.md defines tasks the agent should perform on a schedule. The heartbeat scheduler reads this file and spawns Claude Code sessions to execute each task at the configured cadence.

### Format

```markdown
# Heartbeat

## Tasks

### [Task Name]
- **cadence**: daily | weekly | monthly | cron expression
- **time**: HH:MM (24-hour, agent's configured timezone)
- **day**: monday | tuesday | ... (for weekly tasks)
- **date**: 1-31 (for monthly tasks)
- **enabled**: true | false

#### Instructions

Natural language description of what the agent should do when
this task fires. The agent interprets these instructions and
executes them using its available tools and context.
```

### Example

```markdown
# Heartbeat

## Tasks

### Morning Briefing
- **cadence**: daily
- **time**: 08:00
- **enabled**: true

#### Instructions

Compile a morning briefing with:
1. Weather for my location
2. Today's calendar events
3. Top 3 priority tasks
4. Any unread important messages
5. Health data from last night (sleep, readiness)

Format as a concise bullet list. Save to brain.

---

### Evening Review
- **cadence**: daily
- **time**: 21:00
- **enabled**: true

#### Instructions

Run an evening review:
1. What was accomplished today?
2. What was planned but not completed?
3. Any new information learned about the user?
4. Update USER.md if new facts were discovered
5. Propose tomorrow's top 3 priorities

---

### Weekly Planning
- **cadence**: weekly
- **day**: monday
- **time**: 09:00
- **enabled**: true

#### Instructions

Compile a weekly planning session:
1. Review last week's accomplishments
2. Check project milestones and deadlines
3. Identify blockers
4. Propose this week's goals (max 5)
5. Flag any upcoming meetings that need prep

---

### Health Check-In
- **cadence**: daily
- **time**: 07:00
- **enabled**: false

#### Instructions

Review health data:
1. Last night's sleep score and HRV
2. Weight trend (last 7 days)
3. Exercise log for yesterday
4. Any supplements or medications due today
```

### How the Agent Updates It

The agent can propose new heartbeat tasks or modifications to existing ones. For example:

- After you mention a recurring meeting, the agent might propose a pre-meeting prep task
- If a task consistently produces no useful output, the agent might suggest disabling it
- The agent adjusts task instructions based on what you find useful

Major changes (adding or removing tasks) are confirmed with you before writing. Minor adjustments (refining instructions, adjusting timing) may be made autonomously.

---

## heartbeat-state.json

The heartbeat scheduler maintains state in `heartbeat-state.json`. This file tracks:

```json
{
  "tasks": {
    "morning-briefing": {
      "lastRun": "2026-02-22T08:00:00Z",
      "nextRun": "2026-02-23T08:00:00Z",
      "lastStatus": "success",
      "runCount": 45,
      "consecutiveFailures": 0
    },
    "evening-review": {
      "lastRun": "2026-02-21T21:00:00Z",
      "nextRun": "2026-02-22T21:00:00Z",
      "lastStatus": "success",
      "runCount": 44,
      "consecutiveFailures": 0
    }
  },
  "timezone": "America/New_York",
  "version": 1
}
```

**Fields:**

| Field | Description |
|-------|-------------|
| `lastRun` | ISO timestamp of the last execution |
| `nextRun` | ISO timestamp of the next scheduled execution |
| `lastStatus` | `"success"` or `"error"` |
| `runCount` | Total number of executions |
| `consecutiveFailures` | Number of failures in a row (resets on success) |
| `timezone` | Timezone for interpreting task times |

The scheduler uses this file to determine which tasks are due. If the agent was offline and missed a task, it runs it on the next startup (catch-up behavior).

---

## Document Interaction

The three living documents work together:

- **SOUL.md** tells the agent _how_ to communicate
- **USER.md** tells the agent _what it knows_ about you
- **HEARTBEAT.md** tells the agent _what to do_ on a schedule

When the agent runs a heartbeat task (e.g., morning briefing), it reads all three documents for context: SOUL.md for tone, USER.md for personalization, HEARTBEAT.md for the task instructions.

When the agent has a conversation with you, it reads SOUL.md and USER.md for context, and may update USER.md with new information or SOUL.md with refined preferences.

---

## Best Practices

1. **Let the agent write.** You can manually edit these files, but the best results come from letting the agent evolve them through use.

2. **Review periodically.** Check SOUL.md and USER.md every few weeks to make sure the agent's understanding matches reality.

3. **Start minimal.** The onboard wizard creates a starting point. Resist the urge to write a 2000-line USER.md on day one. Let it grow organically.

4. **Use git history.** Commit your changes regularly to maintain a full history of how these documents evolved. Use `git log` and `git diff` to review changes.

5. **Correct explicitly.** If the agent gets something wrong, tell it directly. "That's wrong, I actually prefer X" is more effective than silently editing the file.
