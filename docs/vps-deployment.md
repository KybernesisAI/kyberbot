# VPS Deployment

How to install and run KyberBot on a VPS for 24/7 uptime. This gives your channels (Telegram, WhatsApp) and heartbeat tasks always-on availability instead of only running when your laptop is open.

---

## Requirements

| Requirement | Minimum |
|-------------|---------|
| **OS** | Ubuntu 22.04+ / Debian 12+ (any Linux works) |
| **RAM** | 2 GB+ (ChromaDB is the heaviest component) |
| **Disk** | 10 GB free |
| **Node.js** | 18+ |
| **Docker** | 20+ (for ChromaDB) |
| **Claude Code** | Installed and authenticated |

---

## Step 1: Install Dependencies

```bash
# Node.js (via nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22

# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker

# Claude Code
npm install -g @anthropic-ai/claude-code

# pm2 (process manager)
npm install -g pm2
```

---

## Step 2: Authenticate Claude Code

Claude Code requires a one-time browser-based login. On a headless VPS, use SSH port forwarding:

```bash
# From your local machine, SSH with port forwarding
ssh -L 9222:localhost:9222 user@your-vps

# On the VPS, start Claude and follow the auth flow
claude
```

The auth URL will open on your local machine through the tunnel. After authenticating, Claude Code stores the session token and won't need the browser again.

**Alternative:** Authenticate Claude Code on your local machine, then copy the auth config to the VPS:

```bash
# On your local machine
scp -r ~/.claude user@your-vps:~/
```

---

## Step 3: Install KyberBot

```bash
# Clone and build
git clone https://github.com/KybernesisAI/kyberbot.git
cd kyberbot
npm install && npm run build
cd packages/cli && npm link && cd ../..

# Create your agent
mkdir ~/my-agent && cd ~/my-agent
kyberbot onboard
```

---

## Step 4: Verify Everything Works

Start the server in the foreground first to confirm all services come up:

```bash
cd ~/my-agent
kyberbot run
```

You should see the splash screen with all services healthy. Press `Ctrl+C` to stop once confirmed.

---

## Step 5: Run with pm2

pm2 keeps KyberBot running in the background, restarts it on crash, and survives server reboots.

```bash
# Start KyberBot as a managed process
pm2 start "kyberbot run" --name kyberbot --cwd ~/my-agent

# Save the process list so pm2 restores it on reboot
pm2 save

# Generate and install the systemd startup script
pm2 startup
# Run the command it prints (sudo env PATH=...)
```

### pm2 Management Commands

```bash
pm2 status           # Health dashboard
pm2 logs kyberbot    # Tail live logs
pm2 logs kyberbot --lines 100  # Last 100 lines
pm2 restart kyberbot # Restart
pm2 stop kyberbot    # Stop
pm2 delete kyberbot  # Remove from pm2
```

---

## Channel Considerations

### Telegram

Works out of the box on a VPS. Telegram uses outbound long-polling, so no inbound ports need to be opened. Just configure your bot token in `.env` during onboard.

### WhatsApp

WhatsApp requires a QR code scan on first connection. You need to see the console output:

```bash
# Start in foreground for QR scan
kyberbot run

# Scan the QR code from your phone
# After connecting, stop and switch to pm2
pm2 start "kyberbot run" --name kyberbot --cwd ~/my-agent
```

The WhatsApp session is stored in `data/whatsapp-auth/` and persists across restarts.

---

## Firewall and bind host

| Port | Purpose | Reachable externally by default? |
|------|---------|----------------------------------|
| 3456 | KyberBot REST API | **No** — bound to `127.0.0.1` |
| 8000 | ChromaDB | No — only accessed locally |

Telegram and WhatsApp both use outbound connections, so no inbound ports are required for messaging on a default install.

### Exposing the REST API on a VPS

As of the bind-host change, the server defaults to **loopback only**. To make it reachable from outside the host (e.g. for the desktop control panel running on a different machine, or for a fleet of agents spanning hosts), you must opt in:

```bash
# in ~/my-agent/.env
KYBERBOT_API_TOKEN=<32+ char random secret>   # required when exposing
KYBERBOT_BIND_HOST=0.0.0.0                    # or a specific interface
```

**Always set `KYBERBOT_API_TOKEN` when you override `KYBERBOT_BIND_HOST` to anything other than loopback.** Without the token, brain / execute / management endpoints are exposed unauthenticated and several of them are RCE-class (arbitrary `claude` subprocess, arbitrary file read). The startup log warns when an exposed bind is combined with a missing token, but the safe assumption is "token first, then expose."

A reverse proxy on the same host (nginx, Caddy) is the recommended pattern — terminate TLS there, talk to `127.0.0.1:3456`, leave `KYBERBOT_BIND_HOST` unset. Only set the bind host when you genuinely need the process listening on an external interface.

---

## Updating on a VPS

```bash
cd ~/my-agent
kyberbot update
pm2 restart kyberbot
```

---

## Monitoring

### Health Check

```bash
# From the VPS
curl http://localhost:3456/health

# Or via CLI
cd ~/my-agent && kyberbot status
```

### Logs

KyberBot writes logs to `~/my-agent/logs/`:
- `heartbeat.log` — heartbeat task execution
- `sleep.log` — sleep agent maintenance
- `channels.log` — channel message processing

pm2 also captures stdout/stderr:
```bash
pm2 logs kyberbot
```

### Uptime Monitoring (Optional)

Point an external uptime monitor (UptimeRobot, Healthchecks.io, etc.) at:

```
http://your-vps-ip:3456/health
```

This returns `{ "status": "ok" }` when the server is running.

---

## Troubleshooting

### Claude Code auth expired

```bash
pm2 stop kyberbot
claude   # re-authenticate
pm2 start kyberbot
```

### ChromaDB not starting

```bash
cd ~/my-agent
docker compose up -d
kyberbot status
```

### Port already in use

```bash
# Find what's using port 3456
lsof -i :3456
kill <PID>
pm2 restart kyberbot
```

### Out of memory

ChromaDB can be memory-hungry. If your VPS is small:

```bash
# Check memory usage
free -h
docker stats

# Restart ChromaDB to free memory
docker compose restart
```
