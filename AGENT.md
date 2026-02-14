# Agent Manual

## Running with Docker

### Start the agent
```bash
docker compose up -d agent
```

### View logs
```bash
docker compose logs -f agent
```

### Access workspace
```bash
docker compose exec agent sh
```

### Test endpoints
```bash
# Check status
curl http://localhost:3000/status

# Check outbox (agent replies)
curl http://localhost:3000/outbox
```

---

## Slack Bot Testing

### Prerequisites
1. Create a Slack App at https://api.slack.com/
2. Enable Socket Mode in the app settings
3. Add permissions:
   - `connections:write` (in Socket Mode settings)
   - `chat:write`, `app_mentions:read`, `im:history` (in OAuth & Permissions)
4. Subscribe to events:
   - `app_mention`
   - `message.im`
5. Install app to workspace
6. Get tokens:
   - `SLACK_BOT_TOKEN` - Bot User OAuth Token (starts with `xoxb-`)
   - `SLACK_APP_TOKEN` - App-Level Token (starts with `xapp-`)

### Run with Slack tokens
```bash
# Set environment variables
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_APP_TOKEN=xapp-...

# Restart with new environment
docker compose up -d --force-recreate agent
```

### Start Slack bridge manually
```bash
# Enter the container
docker compose exec agent sh

# Run Slack bridge
cd /workspace/skills/slack
node server.js --port 3002 --agent http://localhost:3000
```

### Check Slack bridge status
```bash
curl http://localhost:3002/status
```

### Test in Slack
1. Invite the bot to a channel (or it will automatically respond to DMs)
2. @mention the bot or send a direct message
3. The bot should forward the message to the agent
4. The agent's reply should appear in Slack
