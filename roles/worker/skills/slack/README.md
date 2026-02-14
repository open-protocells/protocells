# Slack Bridge

A Slack bot that connects to your agent via Socket Mode.

## Message Notifications

When a new message arrives, you receive a notification with:
- app: "slack"
- channel: channel ID (e.g., "C01234567")
- ts: message timestamp
- thread_ts: (if in a thread) parent message timestamp
- api: base URL for Slack API proxy (e.g., "http://localhost:3002")

## Reading Messages

Use the Slack API (proxied through the bridge):
- GET /api/conversations.history?channel=XXX - get recent messages in a channel
- GET /api/conversations.replies?channel=XXX&ts=YYY - get thread replies

Example: GET http://localhost:3002/api/conversations.history?channel=C01234567

## Replying

Use the reply tool. The source format is: slack:{channel_id}

```
reply({ source: "slack:C01234567", content: "Hello!" })
```

### Reply in Thread

If the message is in a thread (has thread_ts), include it in metadata:

```
reply({ source: "slack:C01234567", content: "Reply in thread", metadata: { thread_ts: "1234567890.123456" } })
```

### Mention User

To mention a user in your reply, use Slack format: <@user_id>

```
reply({ source: "slack:C01234567", content: "Hey <@U12345678>, check this out!" })
```

## Setup Required

1. Create a Slack App at https://api.slack.com/
2. Enable Socket Mode in the app settings
3. Add `connections:write` and `chat:write` permissions
4. Subscribe to `app_mention` and `message.im` events
5. Install the app to your workspace
6. Set the following environment variables:
   - `SLACK_BOT_TOKEN` (Bot User OAuth Token, starts with xoxb-)
   - `SLACK_APP_TOKEN` (App-Level Token, starts with xapp-)
