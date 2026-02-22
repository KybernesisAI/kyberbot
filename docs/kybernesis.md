# Kybernesis -- Optional Cloud Sync

Kybernesis is an optional cloud service that provides backup, cross-device sync, and a web interface for your KyberBot agent's memory. It is entirely optional -- KyberBot works fully offline without it.

---

## What Is Kybernesis

Kybernesis is a hosted AI agent platform that provides:

- **Cloud backup** of your agent's brain (memories, entities, timeline)
- **Cross-device sync** so your agent has the same memory on multiple machines
- **Web interface** for browsing and managing your agent's knowledge
- **API access** to your agent's memory from external tools

Think of it as iCloud for your AI agent's brain.

---

## How to Connect

### Step 1: Create a Kybernesis Account

Sign up at [kybernesis.ai](https://kybernesis.ai) and create a workspace.

### Step 2: Get Your API Key

In the Kybernesis dashboard, go to Settings > API Keys and generate a new key.

### Step 3: Configure KyberBot

Add your API key to `.env`:

```env
KYBERNESIS_API_KEY=your_api_key_here
```

Add your Kybernesis identifiers to `identity.yaml`:

```yaml
kybernesis:
  agent_id: your_agent_id
  workspace_id: your_workspace_id
```

This can also be configured during the onboard wizard (`kyberbot onboard`).

---

## What Syncs

| Data | Syncs | Notes |
|------|-------|-------|
| ChromaDB memories | Yes | Vectors, metadata, tags, tiers |
| Entity graph | Yes | Entities and relationships |
| Timeline | Yes | Events and conversations |
| brain/ markdown files | Yes | All knowledge documents |
| SOUL.md | Yes | Agent personality |
| USER.md | Yes | User knowledge |
| HEARTBEAT.md | Yes | Recurring tasks |
| Skills | Yes | All skill files |
| .env | **No** | Secrets never leave your machine |
| identity.yaml | **No** | Local identity config only |
| data/whatsapp-session/ | **No** | Auth sessions are device-specific |

### Sync Behavior

- **Push**: Local changes are pushed to Kybernesis on a configurable interval (default: 5 minutes)
- **Pull**: Remote changes are pulled at startup and on demand
- **Conflict resolution**: Last-write-wins with local preference. If the same memory is modified on two devices, the most recent edit takes precedence.

---

## Privacy Considerations

### What Kybernesis Sees

When cloud sync is enabled, your agent's memories are stored on Kybernesis servers. This includes:

- The content of all stored memories (conversations, notes, facts)
- Entity graph data (names, relationships)
- Timeline events
- Knowledge documents in `brain/`
- Living documents (SOUL.md, USER.md, HEARTBEAT.md)

### What Kybernesis Does NOT See

- Your `.env` file (API keys, tokens, secrets)
- WhatsApp/Telegram session data
- Your Claude Code subscription credentials
- Anything not explicitly synced

### Data Handling

- Data is encrypted in transit (TLS) and at rest
- You can delete your workspace and all associated data at any time
- Kybernesis does not use your data for model training
- See the Kybernesis [privacy policy](https://kybernesis.ai/privacy) for full details

### Opting Out

You can disconnect at any time by removing the `kybernesis` section from `identity.yaml` and the `KYBERNESIS_API_KEY` from `.env`. Your local data remains intact. Data already synced to Kybernesis remains in your cloud workspace until you delete it manually.

---

## Using Without Kybernesis

KyberBot is fully functional without Kybernesis. All memory, search, and agent features work locally. Kybernesis adds convenience (backup, multi-device) but is not required for any core functionality.

If you prefer to manage your own backups, the entire brain is stored in your project directory under `data/` and `brain/`. You can back it up with any method you prefer (git, rsync, cloud storage, etc.).
