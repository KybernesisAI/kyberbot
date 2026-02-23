---
name: recall
description: "Look up what the agent knows about a person, project, company, place, or topic from the entity graph and timeline. Use proactively whenever the user mentions someone by name, references a project or company, asks about past interactions, or says who is, what do we know about, tell me about, or recall."
allowed-tools: Bash(kyberbot recall *), Bash(kyberbot timeline *), Bash(kyberbot search *)
---

# Recall

Queries the brain's entity graph and timeline to retrieve everything the agent knows about a person, project, company, or topic. This is the read counterpart to the `remember` skill — together they give terminal sessions full bidirectional memory.

## When to Fire

Fire this skill **proactively** when context would help the conversation. Don't wait for the user to say "recall" — if they mention a name or entity and you don't already have context loaded, look it up.

**Always look up when:**
- The user mentions a person by name and you don't have recent context about them
- A project or company is discussed and you need background
- The user asks "what do we know about...", "who is...", "tell me about..."
- You're about to give advice and historical context would improve it
- A meeting or event is referenced and you need details
- The user asks about past decisions, conversations, or interactions

**Don't look up:**
- Entities you already retrieved in this session
- Generic nouns that aren't specific entities ("the project" without a name)
- When the user is clearly giving you information, not asking for it

## How to Recall

### Step 1: Identify the Entity

Extract the person, project, company, or topic name from the conversation. Use the most specific form available (e.g., "Sarah Chen" not just "Sarah").

### Step 2: Query the Brain

For entity lookup (people, companies, projects):
```bash
kyberbot recall "<entity name>"
```

For time-based context (what happened recently):
```bash
kyberbot timeline --today
kyberbot timeline --week
kyberbot timeline --search "<keywords>"
```

For semantic search (broader knowledge):
```bash
kyberbot search "<query>"
```

### Step 3: Use the Context

Weave the retrieved information naturally into your response. Don't dump raw output — synthesize it. If you found relevant history, reference it conversationally: "Last time you spoke with Sarah, you discussed the API integration..."

If nothing is found, don't mention the lookup. Just proceed without that context.

## Examples

**User mentions a person:** "I need to follow up with Jake"
```bash
kyberbot recall "Jake"
```
Then use the context: "Jake is on the infra team — last time you spoke, you discussed the Kubernetes migration. Want me to draft a follow-up about that?"

**User asks about a project:** "What's the status of the dashboard redesign?"
```bash
kyberbot recall "dashboard redesign"
kyberbot timeline --search "dashboard"
```

**User references a past decision:** "Why did we go with PostgreSQL?"
```bash
kyberbot recall "PostgreSQL"
kyberbot search "PostgreSQL decision"
```

## Notes

- Combine `recall` (entity graph) with `timeline` (temporal) and `search` (semantic) for the most complete picture.
- If recall returns multiple matches, use the most relevant one based on conversation context.
- This skill pairs with `remember` — after a conversation where new information surfaces, store it with `remember` so future `recall` queries find it.
