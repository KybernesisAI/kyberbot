---
name: remember
description: "Persist important information from this conversation to long-term memory. Use proactively whenever the user mentions a person, project, company, decision, meeting, deadline, preference, or any fact that future sessions should know about. Also use when the user says remember this, store this, note this, keep track of, or don't forget."
allowed-tools: Bash(kyberbot remember *)
---

# Remember

Stores information from terminal sessions into the brain's full memory pipeline — the same one used by Telegram, WhatsApp, and heartbeat. Without this skill, terminal conversations vanish when the session ends.

The `kyberbot remember` command feeds the same `storeConversation()` pipeline as messaging channels:
- **Timeline** — temporal event index
- **Entity Graph** — people, companies, projects, and their relationships
- **Embeddings** — semantic search (when ChromaDB is available)

## When to Fire

Fire this skill **proactively** — don't wait for the user to say "remember this." If they mention a person, a decision, a project update, a preference, or any fact that future sessions would benefit from knowing — store it.

**Always store when:**
- The user mentions a new person and their role/relationship
- A decision is made about a project, tool, or approach
- Meeting notes or conversation summaries come up
- The user shares facts about themselves, their work, or their goals
- Deadlines, milestones, or schedule changes are discussed
- New projects or initiatives are mentioned

**Don't store:**
- Trivial back-and-forth ("thanks", "ok", "got it")
- Purely mechanical requests ("format this code", "fix the typo")
- Information already stored in this session

## How to Store

### Step 1: Compose the Memory

Summarize the key information in a clear, factual sentence. Include names, dates, and context. The text should be understandable out of context — a future session reading this should immediately grasp what happened.

Good: "Met with Sarah Chen from Notion on Feb 23 to discuss API integration for the dashboard project"
Bad: "Had a meeting about stuff"

### Step 2: Run the Command

```bash
kyberbot remember "<text>"
```

If there's a natural response or additional context to pair with it:

```bash
kyberbot remember "<text>" --response "<context>"
```

### Step 2b: Tag the Memory (when context is clear)

When the user's message tells you the memory belongs to a specific
project, has obvious sensitivity, or is cross-cutting, **tag it**.
ARP scope policies use these tags as the source of truth for what
gets shared with paired peer agents — an untagged memory is invisible
to a project-scoped peer query, a tagged one is matched.

| Flag | When to set | Example |
|---|---|---|
| `--project <slug>` | The memory is specifically about a named project, product, or initiative | `--project alpha`, `--project kyberco-launch` |
| `--tag <name>` (repeatable) | Cross-cutting themes the user has used; client/team names that aren't the primary project | `--tag launch --tag draft` |
| `--classification <tier>` | Content is sensitive | `--classification pii` (SSNs, addresses, health), `--classification confidential` (internal-only), `--classification internal` (default for company info), `--classification public` (already-public info) |

Pick **slugs** for `--project` (lowercase, dashes/underscores) — they need
to match what's typed in the ARP scope picker on the cloud side.
"Project Alpha" → `alpha`. "Q2 Launch" → `q2-launch`.

**Don't make up tags.** Only set `--project` / `--tag` when the user
has clearly named a project or theme — guessing from context risks
mis-scoping and a peer agent seeing or missing the wrong memories.

### Step 3: Confirm

Briefly acknowledge to the user that the information has been stored. A simple "Noted." or "Stored." suffices unless the user explicitly asked you to remember something, in which case confirm what you stored.

## Examples

**Person mentioned (no project context):** User says "I talked to Jake from the infra team about migrating to Kubernetes"
```bash
kyberbot remember "Talked to Jake from the infra team about migrating to Kubernetes"
```

**Decision in a named project:** User says "For project alpha, let's go with Next.js for the frontend"
```bash
kyberbot remember "Decision: using Next.js for the frontend" \
  --response "Chosen over Remix and SvelteKit" \
  --project alpha
```

**Meeting notes scoped to a project:** User shares detailed Q2 launch meeting notes
```bash
kyberbot remember "Weekly sync with product team — discussed Q2 roadmap, prioritized auth overhaul and dashboard redesign" \
  --response "Auth overhaul starts March 1, dashboard redesign in April. Sarah leading auth, Mike on dashboard." \
  --project q2-launch \
  --tag roadmap
```

**Sensitive content:** User pastes a client SSN or contract terms
```bash
kyberbot remember "Acme Corp contract: $250K/year, auto-renews 2027-01-01" \
  --project acme-deal \
  --classification confidential
```

**PII (highest sensitivity tier):** User mentions a person's home address or health status
```bash
kyberbot remember "Sarah's home address is 123 Maple St" \
  --classification pii
```

## Correction Detection

When the user says things like:
- "That's wrong about [entity]"
- "Actually, [entity] works at [X], not [Y]"
- "No, [correct fact]"
- "Forget that about [entity]"
- "[Entity] doesn't work at [X] anymore"

Treat this as a correction:

1. Run `kyberbot recall "<entity>"` to see what you currently know
2. Store the **correct** fact with `kyberbot remember` — the contradiction detection system will automatically supersede the old, lower-confidence fact
3. Confirm briefly: "Corrected."

The memory system uses source confidence weighting — facts stored via terminal `remember` get 0.95 confidence (user-direct), which is higher than chat messages (0.85) or AI-extracted facts (0.60). So a correction stored here will naturally take precedence over earlier, less-reliable information.

If the user says something is wrong but doesn't provide a replacement (e.g., "That's not true about John"), acknowledge the issue and ask what the correct information is.

## Notes

- This skill complements (not replaces) updating USER.md, SOUL.md, and brain/ files. Use those for structured, long-lived information. Use `remember` for capturing the stream of events and facts.
- Memories are searchable via `kyberbot recall`, `kyberbot timeline`, and `kyberbot search`.
