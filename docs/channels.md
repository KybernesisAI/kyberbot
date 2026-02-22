# Channels -- Messaging Integration

Channels allow you to communicate with your KyberBot agent from messaging platforms. Instead of opening a terminal and running `claude`, you can send a message on Telegram or WhatsApp and get a response from your agent.

---

## Overview

KyberBot supports two messaging channels:

| Channel | Auth Method | Features |
|---------|------------|----------|
| **Telegram** | BotFather token | Text messages, inline commands, file sharing |
| **WhatsApp** | QR code scan | Text messages, voice notes, media |

Both channels are optional. You can use KyberBot entirely through the terminal if you prefer.

### How Channels Work

1. You send a message on Telegram or WhatsApp
2. The KyberBot server receives the message via webhook
3. The message is forwarded to a Claude Code session
4. Claude Code processes the message with full agent context (SOUL.md, USER.md, brain, skills)
5. The response is sent back to your messaging app

```
┌──────────┐     webhook     ┌──────────┐     stdin     ┌──────────┐
│ Telegram │ ───────────────▶│ KyberBot │ ─────────────▶│  Claude  │
│    or    │                 │  Server  │                │   Code   │
│ WhatsApp │◀─────────────── │          │◀───────────── │          │
└──────────┘     response    └──────────┘     stdout    └──────────┘
```

---

## Telegram Setup

### Step 1: Create a Bot with BotFather

1. Open Telegram and search for `@BotFather`
2. Send `/newbot`
3. Follow the prompts to choose a name and username for your bot
4. BotFather will give you a token like: `7123456789:AAHfF3k...`

### Step 2: Configure KyberBot

Add the token to your `.env` file:

```env
TELEGRAM_BOT_TOKEN=7123456789:AAHfF3k...
```

Or run the setup command:

```bash
kyberbot channels telegram setup
```

### Step 3: Start the Channel

If you used the setup command, Telegram will start automatically with `kyberbot run`. You can also start it independently:

```bash
kyberbot channels telegram start
```

### Step 4: Test It

Open Telegram, find your bot, and send a message:

```
You: Hey, what's on my schedule today?
Bot: Here's your schedule for today...
```

### Telegram Commands

Your bot responds to regular messages. You can also register slash commands with BotFather for quick actions:

```
/briefing - Morning briefing
/status   - Service status
/search   - Search memory
/help     - Show available commands
```

To register commands, send this to BotFather:

```
/setcommands
```

Then paste your command list.

### Security

- Only your Telegram user ID can interact with the bot (configured during setup)
- Messages from other users are ignored
- Set your user ID in `.env`:

```env
TELEGRAM_ALLOWED_USERS=123456789
```

Multiple users can be comma-separated: `123456789,987654321`

To find your Telegram user ID, send a message to `@userinfobot`.

---

## WhatsApp Setup

### Step 1: Configure

```bash
kyberbot channels whatsapp setup
```

This starts the WhatsApp Web authentication flow.

### Step 2: Scan QR Code

A QR code will appear in your terminal. Scan it with WhatsApp on your phone:

1. Open WhatsApp on your phone
2. Go to Settings > Linked Devices
3. Tap "Link a Device"
4. Scan the QR code displayed in the terminal

### Step 3: Verify Connection

Once scanned, the terminal will show:

```
  ✓ WhatsApp connected
  ✓ Session saved for future reconnection
```

The session is persisted, so you will not need to scan again unless you log out.

### Step 4: Test It

Send a WhatsApp message to the number linked to the session:

```
You: What did I accomplish yesterday?
Bot: Based on your timeline, yesterday you...
```

### WhatsApp Considerations

- WhatsApp uses your personal phone number as the agent's number
- The session persists in `data/whatsapp-session/`
- If the session expires, re-run `kyberbot channels whatsapp setup`
- Rate limits apply per WhatsApp's terms of service

---

## Channel Interface

Both channels implement a common `Channel` interface. This makes it straightforward to add new messaging platforms in the future.

### Interface Definition

```typescript
interface Channel {
  /** Unique channel identifier */
  name: string;

  /** Initialize the channel (connect, authenticate) */
  start(): Promise<void>;

  /** Gracefully shut down the channel */
  stop(): Promise<void>;

  /** Send a message to the user */
  send(message: string): Promise<void>;

  /** Register a handler for incoming messages */
  onMessage(handler: (message: IncomingMessage) => Promise<string>): void;

  /** Check if the channel is currently connected */
  isConnected(): boolean;
}

interface IncomingMessage {
  /** Raw text content */
  text: string;

  /** Sender identifier */
  from: string;

  /** Timestamp */
  timestamp: Date;

  /** Optional attached media */
  media?: {
    type: 'image' | 'audio' | 'document';
    url: string;
    filename?: string;
  };
}
```

### Adding a New Channel

To add a new messaging platform:

1. Create a directory in `packages/cli/src/channels/`:

   ```
   packages/cli/src/channels/discord/
   ├── index.ts
   └── types.ts
   ```

2. Implement the `Channel` interface

3. Register the channel in the service startup flow

4. Add configuration to `.env` and the onboard wizard

See [CONTRIBUTING.md](../CONTRIBUTING.md) for more details.

---

## Message Routing

When a message arrives from any channel, it goes through the following pipeline:

### 1. Authentication

The server verifies the message is from an allowed user. Unauthorized messages are silently dropped.

### 2. Context Loading

The agent loads:
- SOUL.md (personality)
- USER.md (user knowledge)
- Recent conversation history for the channel
- Any relevant memories from the brain

### 3. Processing

The message is sent to Claude Code for processing. The agent has access to all its tools: brain search, entity graph, timeline, skills, file system, and web access.

### 4. Response

The agent's response is sent back through the originating channel. Long responses may be split into multiple messages based on the platform's character limits.

### 5. Memory

The conversation is stored in the brain (ChromaDB) and timeline (SQLite) for future reference.

---

## Channel Commands

```bash
# List configured channels
kyberbot channels list

# Start a specific channel
kyberbot channels telegram start
kyberbot channels whatsapp start

# Stop a specific channel
kyberbot channels telegram stop
kyberbot channels whatsapp stop

# Check channel status
kyberbot channels status

# Re-run setup for a channel
kyberbot channels telegram setup
kyberbot channels whatsapp setup
```

---

## Troubleshooting

### Telegram bot not responding

- Verify the token in `.env` is correct
- Check that your Telegram user ID is in `TELEGRAM_ALLOWED_USERS`
- Run `kyberbot channels status` to see if the channel is running
- Check logs: `kyberbot channels telegram logs`

### WhatsApp disconnected

- Run `kyberbot channels whatsapp setup` to re-authenticate
- Delete `data/whatsapp-session/` and set up from scratch if authentication fails
- Ensure your phone has an active internet connection (WhatsApp Web requires the phone to be online)

### Messages delayed

- Claude Code processing can take several seconds for complex queries
- Check that the heartbeat scheduler is not consuming all available Claude Code sessions
- Verify your internet connection
