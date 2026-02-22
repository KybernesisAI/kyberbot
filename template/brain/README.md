# Brain

This directory stores your agent's long-term knowledge as markdown files.

The agent writes here when it learns something worth remembering — meeting notes, project context, insights, weekly reviews.

## Structure

Files are organized by the agent however it sees fit. Common patterns:

```
brain/
├── projects/        # Project context and notes
├── people/          # What the agent knows about people you mention
├── weekly-reviews/  # Heartbeat-generated weekly summaries
├── heartbeat/       # Heartbeat task results
└── insights/        # Agent-generated observations
```

## How It Works

- The agent creates files here during conversation or via heartbeat tasks
- ChromaDB indexes these files for semantic search
- The sleep agent maintains tags, summaries, and relationships
- Git sync auto-commits changes for version control

You can also manually add markdown files here and the agent will index them.
