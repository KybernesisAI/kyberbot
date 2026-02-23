---
name: brain-note
description: "Save long-form knowledge, research findings, architecture decisions, reference material, or structured notes to the brain/ directory for persistent retrieval. Use when the user shares detailed information that doesn't fit a single memory, discusses architecture or design decisions, provides reference material, shares meeting notes or research, or says save this to the brain, write this down, document this, or take notes on."
allowed-tools: Read, Write, Edit, Glob, Bash(kyberbot brain *)
---

# Brain Note

Persists structured, long-form knowledge to the `brain/` directory. While the `remember` skill captures individual facts and events into the timeline and entity graph, `brain-note` is for richer content that benefits from being a readable document — architecture decisions, research findings, meeting notes, reference material, project context.

## When to Fire

**Always write a brain note when:**
- The user shares or discusses an architecture or design decision with rationale
- Research findings or analysis results come up that should be referenced later
- Detailed meeting notes are shared (beyond what a single `remember` call captures)
- The user provides reference material, specs, or documentation to retain
- A complex topic is discussed that warrants a structured writeup
- Project context or onboarding information is shared
- The user explicitly asks to document or write something down

**Don't write a brain note for:**
- Single facts or events — use `remember` instead
- Information about the user — update USER.md instead
- Information about the agent's identity — update SOUL.md instead
- Recurring task definitions — update HEARTBEAT.md instead

## How to Write

### Step 1: Choose the Right File

Organize brain notes by topic. Use descriptive filenames in kebab-case:

```
brain/project-dashboard-redesign.md
brain/architecture-decisions.md
brain/meeting-notes-2025-02.md
brain/reference-api-endpoints.md
```

If a relevant file already exists, **append** to it rather than creating a new one. Check first:
```bash
ls brain/
```

### Step 2: Write the Note

Use clear markdown with dates and context. Every note should be understandable on its own — a future session reading it should immediately grasp the content without needing the original conversation.

Structure for **decisions**:
```markdown
## [Decision Title] — [Date]

**Context**: [Why this decision was needed]
**Decision**: [What was decided]
**Rationale**: [Why this option was chosen]
**Alternatives considered**: [What else was evaluated]
**Implications**: [What this means going forward]
```

Structure for **meeting notes**:
```markdown
## [Meeting Title] — [Date]

**Attendees**: [Who was there]
**Summary**: [Key points]
**Decisions**: [What was decided]
**Action items**: [What needs to happen next]
```

Structure for **research/reference**:
```markdown
## [Topic] — [Date]

[Findings, analysis, or reference material organized with clear headings]
```

### Step 3: Index It

After writing, also store a summary in the memory pipeline so the note is discoverable via search and timeline:
```bash
kyberbot remember "Brain note: [brief description of what was documented]" --response "[one-line summary of key content]"
```

### Step 4: Confirm

Tell the user where the note was saved: "Documented in brain/[filename].md"

## Examples

**Architecture decision discussed:**
```
brain/architecture-decisions.md (append):

## Frontend Framework Choice — 2025-02-23

**Context**: Needed to choose a framework for the new dashboard
**Decision**: Next.js with App Router
**Rationale**: SSR support, team familiarity, strong ecosystem
**Alternatives considered**: Remix (less mature), SvelteKit (team unfamiliar)
**Implications**: Lock into React ecosystem, need to learn App Router patterns
```

**Research findings shared:**
```
brain/kubernetes-migration.md (new file):

# Kubernetes Migration Research — 2025-02-23

## Current State
Running on bare EC2 instances with manual deploys...

## Findings
...
```

## Notes

- Brain notes are searchable via `kyberbot search` and `kyberbot brain query`.
- Use `remember` for the event/fact stream, `brain-note` for the knowledge base. They complement each other.
- Keep files focused. One file per project or topic area is better than one giant file.
- Always include dates so future sessions know when information was captured.
