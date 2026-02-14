const SLACK_APP_NAME = 'slack';

import { WebClient } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';
import http from 'node:http';

const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const PORT = parseInt(getArg('--port', '3002'), 10);
const WORKSPACE = getArg('--workspace', '/workspace');
const AGENT_URL = getArg('--agent', 'http://localhost:3000');

const botToken = process.env.SLACK_BOT_TOKEN;
const appToken = process.env.SLACK_APP_TOKEN;

if (!botToken || !appToken) {
  console.error('[slack] ERROR: SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required');
  process.exit(1);
}

const slack = new WebClient(botToken);

const unreadMentions = new Set();
const processedMessages = new Set();

async function notifyAgent(event, envelopeId) {
  const channel = event.channel;
  const ts = event.ts;
  const msgKey = channel + ':' + ts;

  if (processedMessages.has(msgKey)) {
    console.log('[slack] duplicate message skipped: ' + msgKey);
    return;
  }
  processedMessages.add(msgKey);

  if (event.type === 'app_mention') {
    unreadMentions.add(ts);
  }

  const source = 'slack:' + channel;
  const content = event.text ? event.text.replace(/<@[A-Z0-9]+>/g, '').trim() : '';

  console.log('[slack] new message in ' + channel + ': ' + content.slice(0, 50));

  const notification = {
    app: SLACK_APP_NAME,
    channel,
    ts,
    unreadMentions: unreadMentions.size,
    api: 'http://localhost:' + PORT
  };

  if (event.thread_ts) {
    notification.thread_ts = event.thread_ts;
  }

  try {
    await fetch(AGENT_URL + '/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '[slack] 你有新消息，channel: ' + channel,
        source,
        metadata: notification
      }),
    });
  } catch (err) {
    console.error('[slack] error notifying agent:', err);
  }
}

const socketModeClient = new SocketModeClient({
  appToken: appToken,
});

socketModeClient.on('app_mention', async (args) => {
  console.log('[slack] app_mention event:', JSON.stringify(args).slice(0, 200));
  await notifyAgent(args.event, args.envelope_id);
});

socketModeClient.on('message', async (args) => {
  console.log('[slack] message event:', JSON.stringify(args).slice(0, 200));
  if (args.event?.channel_type === 'im') {
    await notifyAgent(args.event, args.envelope_id);
  }
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost:' + PORT);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'POST' && url.pathname === '/reply') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { source, content } = JSON.parse(body);
        const match = source?.match(/^slack:(.+)$/);
        if (!match) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'invalid source' }));
          return;
        }

        const channel = match[1];
        console.log('[slack] reply to ' + channel + ': ' + content.slice(0, 50));

        const result = await slack.chat.postMessage({
          channel: channel,
          text: content,
        });

        console.log('[slack] postMessage result: ts=' + result.ts);

        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error('[slack] reply error:', err);
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/status') {
    res.writeHead(200);
    res.end(JSON.stringify({
      bridge: 'slack',
      connected,
      agentUrl: AGENT_URL
    }));
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/conversations.history')) {
    try {
      const result = await slack.conversations.history({
        channel: url.searchParams.get('channel'),
        limit: parseInt(url.searchParams.get('limit') || '10', 10)
      });
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/conversations.replies')) {
    try {
      const result = await slack.conversations.replies({
        channel: url.searchParams.get('channel'),
        ts: url.searchParams.get('ts'),
        limit: parseInt(url.searchParams.get('limit') || '10', 10)
      });
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  console.log('[slack] HTTP server listening on http://localhost:' + PORT);
});

let connected = false;

socketModeClient.on('connecting', () => {
  console.log('[slack] connecting...');
});

socketModeClient.on('connected', () => {
  connected = true;
  console.log('[slack] Socket Mode connected');
});

socketModeClient.on('disconnected', () => {
  connected = false;
  console.log('[slack] Socket Mode disconnected, will reconnect...');
});

socketModeClient.on('error', (error) => {
  console.error('[slack] Socket Mode error:', error);
});

(async () => {
  while (true) {
    try {
      await socketModeClient.start();
      break;
    } catch (err) {
      console.error('[slack] failed to connect, retrying in 5s...', err);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  console.log('[slack] Socket Mode connected');
  console.log('[slack] agent at ' + AGENT_URL);
})();
