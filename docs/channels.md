# Channels -- Messaging Integration

Channels allow you to communicate with your KyberBot agent from messaging platforms. Instead of opening a terminal and running `claude`, you can send a message on Telegram or WhatsApp and get a response from your agent.

---

## Overview

KyberBot supports two messaging channels:

| Channel | Auth Method | Features |
|---------|------------|----------|
| **Telegram** | BotFather token + verification code | Text messages, owner-only access |
| **WhatsApp** | QR code scan | Text messages, voice notes, media |

Both channels are optional. You can use KyberBot entirely through the terminal if you prefer.

### How Channels Work

1. You send a message on Telegram or WhatsApp
2. The KyberBot server receives the message
3. The message is forwarded to a Claude Code session
4. Claude Code processes the message with full agent context (SOUL.md, USER.md, brain, skills)
5. The response is sent back to your messaging app

```
┌──────────┐                 ┌──────────┐                ┌──────────┐
│ Telegram │ ───────────────▶│ KyberBot │ ──────────────▶│  Claude  │
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

### Step 2: Add the Channel

```bash
kyberbot channel add telegram
```

This prompts for your bot token and saves it to `identity.yaml`.

### Step 3: Start KyberBot

```bash
kyberbot
```

On first start with a new Telegram bot, KyberBot enters **verification mode**. You will see a message in the console:

```
Send /start ABCDEF to your Telegram bot to verify ownership
```

### Step 4: Verify Ownership

Open Telegram, find your bot, and send:

```
/start ABCDEF
```

(Replace `ABCDEF` with the actual code from your console.)

If the code is correct, the bot replies:

```
Connected! I'm [AgentName]. You are now the verified owner.
```

Your Telegram `chat_id` is saved to `identity.yaml` as `owner_chat_id`. From this point on, **only messages from your account are processed**. Messages from anyone else are silently ignored.

### Step 5: Chat

Send any message to your bot and it will respond as your agent, with full personality (SOUL.md) and user knowledge (USER.md):

```
You: Hey, what's on my schedule today?
Bot: Here's your schedule for today...
```

### Re-verification

If you need to re-pair (new phone, new Telegram account):

```bash
kyberbot channel add telegram --reverify
```

This clears `owner_chat_id` from `identity.yaml`. The next time you start KyberBot, a new verification code will be generated.

### Security Model

- **One-time verification code**: Printed to the server console (never sent over the network)
- **Owner-only access**: After verification, only the verified `owner_chat_id` can interact with the bot
- **Silent rejection**: Messages from non-owners are silently ignored (no error response)
- **Persistent**: The `owner_chat_id` survives restarts -- you only verify once

---

## WhatsApp Setup

### Step 1: Configure

```bash
kyberbot channel add whatsapp
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
  WhatsApp connected
  Session saved for future reconnection
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
- If the session expires, re-run `kyberbot channel add whatsapp`
- Rate limits apply per WhatsApp's terms of service

---

## Channel Interface

Both channels implement a common `Channel` interface. This makes it straightforward to add new messaging platforms in the future.

### Interface Definition

```typescript
interface Channel {
  /** Unique channel identifier */
  readonly name: string;

  /** Initialize the channel (connect, authenticate) */
  start(): Promise<void>;

  /** Gracefully shut down the channel */
  stop(): Promise<void>;

  /** Send a message to a recipient */
  send(to: string, message: string): Promise<void>;

  /** Check if the channel is currently connected */
  isConnected(): boolean;

  /** Register a handler for incoming messages */
  onMessage(handler: (message: ChannelMessage) => Promise<void>): void;
}

interface ChannelMessage {
  /** Unique message identifier */
  id: string;

  /** Channel type (e.g., 'telegram', 'whatsapp') */
  channelType: string;

  /** Sender identifier */
  from: string;

  /** Raw text content */
  text: string;

  /** Timestamp */
  timestamp: Date;

  /** Optional extra data */
  metadata?: Record<string, unknown>;
}
```

### Adding a New Channel

To add a new messaging platform:

1. Create a file in `packages/cli/src/server/channels/`:

   ```
   packages/cli/src/server/channels/discord.ts
   ```

2. Implement the `Channel` interface

3. Register the channel in `packages/cli/src/server/index.ts`

4. Add configuration to `identity.yaml` and the onboard wizard

See [CONTRIBUTING.md](../CONTRIBUTING.md) for more details.

---

## Message Routing

When a message arrives from any channel, it goes through the following pipeline:

### 1. Authentication

The server verifies the message is from the verified owner. Unauthorized messages are silently dropped.

### 2. Context Loading

The agent loads:
- SOUL.md (personality)
- USER.md (user knowledge)
- Recent conversation history for the channel
- Any relevant memories from the brain

### 3. Processing

The message is sent to Claude Code for processing. The agent has access to all its tools: brain search, entity graph, timeline, skills, file system, and web access.

### 4. Response

The agent's response is sent back through the originating channel. Long responses are split into multiple messages based on the platform's character limits (Telegram: 4096 characters).

### 5. Memory

The conversation is stored in the brain (ChromaDB) and timeline (SQLite) for future reference.

---

## Channel Commands

```bash
# List configured channels
kyberbot channel list

# Add a channel
kyberbot channel add telegram
kyberbot channel add whatsapp

# Re-verify Telegram (clears owner and generates new code)
kyberbot channel add telegram --reverify

# Remove a channel
kyberbot channel remove telegram
kyberbot channel remove whatsapp

# Check channel status
kyberbot channel status
```

---

## Troubleshooting

### Telegram bot not responding

- Verify the bot token in `identity.yaml` is correct
- Check that you have completed the verification flow (look for `owner_chat_id` in `identity.yaml`)
- Run `kyberbot channel status` to see if the channel is configured
- Restart KyberBot if the bot was recently created

### Telegram verification code not working

- Codes are case-sensitive -- type them exactly as shown
- Each code is single-use. If you restart KyberBot, a new code is generated
- Make sure you are sending `/start CODE` (with the `/start` prefix)

### WhatsApp disconnected

- Run `kyberbot channel add whatsapp` to re-authenticate
- Delete `data/whatsapp-session/` and set up from scratch if authentication fails
- Ensure your phone has an active internet connection (WhatsApp Web requires the phone to be online)

### Messages delayed

- Claude Code processing can take several seconds for complex queries
- Check that the heartbeat scheduler is not consuming all available Claude Code sessions
- Verify your internet connection
