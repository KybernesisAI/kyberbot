# Brain -- Memory Architecture

The brain is KyberBot's long-term memory system. It allows the agent to remember conversations, track relationships between people and projects, maintain a timeline of events, and continuously improve memory quality through a background maintenance process.

---

## Overview

The brain consists of four components:

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Vector Store** | ChromaDB | Semantic search across all memories |
| **Entity Graph** | SQLite | Track people, companies, projects, and relationships |
| **Timeline** | SQLite | Temporal log of events and conversations |
| **Sleep Agent** | Background process | Continuous memory maintenance and quality improvement |

All data lives locally in your KyberBot project directory. Nothing leaves your machine unless you opt into Kybernesis cloud sync.

---

## ChromaDB -- Vector Store

ChromaDB provides semantic search over all stored memories. When the agent saves a piece of information, it is embedded as a vector and stored in ChromaDB, enabling meaning-based retrieval.

### How It Works

1. Agent stores a memory (conversation summary, fact, note)
2. The text is converted to a vector embedding
3. The embedding is stored in ChromaDB with metadata (tags, timestamp, priority, tier)
4. When searching, the query is embedded and compared against stored vectors
5. Results are ranked by cosine similarity combined with keyword matching

### Storage

ChromaDB runs as a Docker container. Data is persisted to `data/chroma/` in your project directory.

```bash
# ChromaDB starts automatically with kyberbot run
# Manual control:
kyberbot brain chroma start
kyberbot brain chroma stop
kyberbot brain chroma status
```

### Metadata

Each memory stored in ChromaDB includes:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier |
| `content` | string | The memory text |
| `embedding` | float[] | Vector representation |
| `tags` | string[] | Categorization tags |
| `timestamp` | ISO string | When the memory was created |
| `priority` | float (0-1) | Importance score |
| `tier` | string | `hot`, `warm`, or `archive` |
| `source` | string | Where the memory came from (conversation, heartbeat, manual) |
| `entities` | string[] | People/projects/companies mentioned |

---

## SQLite -- Entity Graph

The entity graph tracks discrete entities (people, companies, projects, places, topics) and the relationships between them. It is stored in a SQLite database at `data/entities.db`.

### Entity Types

| Type | Examples |
|------|----------|
| `person` | Colleagues, friends, family members |
| `company` | Employers, clients, vendors |
| `project` | Active projects, side projects |
| `place` | Cities, offices, venues |
| `topic` | Technologies, interests, goals |

### Schema

**Entities table:**

```sql
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  summary TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  mention_count INTEGER DEFAULT 1,
  metadata TEXT  -- JSON
);
```

**Relationships table:**

```sql
CREATE TABLE relationships (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation TEXT NOT NULL,  -- e.g., "works_at", "manages", "related_to"
  weight REAL DEFAULT 1.0,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  FOREIGN KEY (source_id) REFERENCES entities(id),
  FOREIGN KEY (target_id) REFERENCES entities(id)
);
```

### Querying

```bash
# List all tracked entities
kyberbot brain entities

# Query a specific entity
kyberbot brain entities "John"

# Show relationships
kyberbot brain entities --relationships
```

The agent also queries the entity graph during conversation when it needs to recall information about people, projects, or organizations.

---

## SQLite -- Timeline

The timeline is a temporal log of events, conversations, and notes. It answers "when did X happen?" questions. Stored in `data/timeline.db`.

### Schema

```sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  type TEXT NOT NULL,  -- conversation, heartbeat, note, event
  entities TEXT,       -- JSON array of entity IDs
  topics TEXT,         -- JSON array of topic strings
  source TEXT,         -- Where this event came from
  metadata TEXT        -- JSON
);
```

### Querying

```bash
# Recent timeline
kyberbot brain timeline

# Today's events
kyberbot brain timeline --today

# This week
kyberbot brain timeline --week

# Search
kyberbot brain timeline --search "product launch"
```

---

## brain/ Directory -- Markdown Knowledge

The `brain/` directory in your project root stores longer-form knowledge as markdown files. This is for structured information that does not fit neatly into vector search or the entity graph.

**Examples:**

- `brain/projects/payflow.md` -- Detailed project notes
- `brain/people/team.md` -- Team member profiles
- `brain/decisions/architecture-choices.md` -- Decision log

The agent reads and writes files in `brain/` as needed. These files are also indexed in ChromaDB for search.

---

## Hybrid Search

When the agent searches memory, it uses a hybrid approach combining semantic and keyword search:

```
Final Score = (0.7 * semantic_score) + (0.3 * keyword_score) + priority_boost + tier_boost
```

### Scoring Breakdown

| Component | Weight | Method |
|-----------|--------|--------|
| Semantic score | 70% | Cosine similarity of embeddings |
| Keyword score | 30% | BM25 text matching |
| Priority boost | +0.1 max | Based on memory priority (0-1) |
| Tier boost | variable | Hot: +0.05, Warm: +0.0, Archive: -0.05 |

### Search Commands

```bash
# Basic search
kyberbot brain search "pricing discussion"

# Filter by entity
kyberbot brain search "API" --entity "John"

# Filter by time
kyberbot brain search "meeting" --after "last week"

# Filter by tier
kyberbot brain search "roadmap" --tier hot

# Filter by minimum priority
kyberbot brain search "launch" --min-priority 0.5
```

---

## Sleep Agent

The sleep agent is a background process that continuously maintains memory quality. It runs in cycles, performing six steps in order.

### The 6-Step Cycle

#### 1. Decay

Reduces the priority of memories that have not been accessed recently. This ensures that stale information naturally falls to lower tiers while frequently-accessed memories remain prominent.

**Logic:**
- Memories not accessed in 7+ days: priority reduced by 0.05
- Memories not accessed in 30+ days: priority reduced by 0.10
- Minimum priority floor: 0.1 (nothing decays to zero)

#### 2. Tag

Refreshes tags on memories using AI analysis. Over time, tagging conventions evolve, and older memories may have inconsistent or missing tags. The tag step normalizes and enriches tags.

**Logic:**
- Scans memories with outdated or sparse tags
- Uses a lightweight model to suggest improved tags
- Applies tags without modifying memory content

#### 3. Link

Discovers connections between related memories using Jaccard similarity on tags and entities. When two memories share significant overlap, an edge is created between them.

**Logic:**
- Compares tag sets and entity sets between memories
- Creates edges when Jaccard similarity exceeds threshold (default: 0.3)
- Edges are stored in `data/sleep.db` for relationship queries

#### 4. Tier

Manages the hot/warm/archive tier system based on access patterns and priority scores.

| Tier | Criteria | Search Behavior |
|------|----------|-----------------|
| `hot` | Priority >= 0.7 and accessed in last 7 days | Boosted in results |
| `warm` | Priority >= 0.3 or accessed in last 30 days | Normal ranking |
| `archive` | Priority < 0.3 and not accessed in 30+ days | Penalized in results |

Memories move between tiers automatically based on access patterns.

#### 5. Summarize

Regenerates summaries for memories that have changed tiers. When a memory moves from hot to warm, or warm to archive, a new summary is generated to capture its essence more concisely.

#### 6. Entity Hygiene

Cleans up the entity graph:
- Merges duplicate entities (e.g., "John Smith" and "John S.")
- Updates last-seen timestamps
- Removes orphaned relationships
- Recalculates mention counts

### Sleep Agent Commands

```bash
# Check status
kyberbot sleep status

# Trigger a cycle manually
kyberbot sleep run

# View memory relationships (edges)
kyberbot sleep edges

# Database health check
kyberbot sleep health
```

### Sleep Database

The sleep agent maintains its own SQLite database at `data/sleep.db` for tracking edges, cycle history, and tier transitions.

---

## Data Flow

```
User Conversation
       │
       ▼
  ┌─────────┐     store      ┌──────────┐
  │  Agent   │ ──────────────▶│ ChromaDB │
  │ (Claude  │                │ (vectors)│
  │  Code)   │     store      ├──────────┤
  │          │ ──────────────▶│ SQLite   │
  │          │                │(entities,│
  │          │                │ timeline)│
  │          │     read       ├──────────┤
  │          │◀──────────────│ brain/   │
  │          │     write      │(markdown)│
  │          │ ──────────────▶│          │
  └─────────┘                └──────────┘
                                   │
                              ┌────▼────┐
                              │  Sleep  │
                              │  Agent  │
                              │ (decay, │
                              │  tag,   │
                              │  link,  │
                              │  tier,  │
                              │summarize│
                              │ entity  │
                              │hygiene) │
                              └─────────┘
```

---

## File Locations

| File / Directory | Purpose |
|------------------|---------|
| `data/chroma/` | ChromaDB persistent storage |
| `data/entities.db` | Entity graph (SQLite) |
| `data/timeline.db` | Timeline (SQLite) |
| `data/sleep.db` | Sleep agent state (SQLite) |
| `brain/` | Markdown knowledge files |
| `heartbeat-state.json` | Heartbeat scheduler state |

---

## Privacy

All brain data is stored locally in your project directory. The agent never sends memory data to external services unless you explicitly configure Kybernesis cloud sync. See [Kybernesis](kybernesis.md) for details on optional cloud sync.
