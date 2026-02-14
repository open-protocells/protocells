import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { MessageQueue } from './queue.js';
import type { OutboxMessage } from './types.js';

export interface ServerContext {
  queue: MessageQueue;
  workspacePath: string;
  getStatus: () => {
    status: string;
    round: number;
    provider: string;
    model?: string;
    error?: { message: string; stack?: string; timestamp: number; source: string };
  };
}

export function createServer(ctx: ServerContext, port: number = 3000): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    res.setHeader('Content-Type', 'application/json');

    try {
      // POST /message
      if (req.method === 'POST' && url.pathname === '/message') {
        const body = await readBody(req);
        const { content, source, metadata } = JSON.parse(body);

        if (!content || typeof content !== 'string') {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'content is required' }));
          return;
        }

        const msg = ctx.queue.push(content, source ?? 'http:' + Date.now(), metadata);
        res.writeHead(200);
        res.end(JSON.stringify({ messageId: msg.id }));
        return;
      }

      // GET /status
      if (req.method === 'GET' && url.pathname === '/status') {
        res.writeHead(200);
        res.end(JSON.stringify(ctx.getStatus()));
        return;
      }

      // POST /repair-signal
      if (req.method === 'POST' && url.pathname === '/repair-signal') {
        const signalPath = path.join(ctx.workspacePath, '.repair-signal');
        fs.writeFileSync(signalPath, JSON.stringify({ timestamp: Date.now() }));
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // GET /outbox
      if (req.method === 'GET' && url.pathname === '/outbox') {
        const outboxDir = path.join(ctx.workspacePath, 'outbox');
        const messages = readOutbox(outboxDir);
        res.writeHead(200);
        res.end(JSON.stringify(messages));
        return;
      }

      // GET /history?offset=0&limit=20
      if (req.method === 'GET' && url.pathname === '/history') {
        const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
        const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 100);
        const result = readHistoryList(ctx.workspacePath, offset, limit);
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      // GET /history/:round
      if (req.method === 'GET' && url.pathname.startsWith('/history/')) {
        const roundStr = url.pathname.slice('/history/'.length);
        const roundNum = parseInt(roundStr, 10);
        if (isNaN(roundNum) || roundNum < 0) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'invalid round number' }));
          return;
        }
        const detail = readHistoryDetail(ctx.workspacePath, roundNum);
        if (!detail) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'round not found' }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(detail));
        return;
      }

      // DELETE /outbox/:id
      if (req.method === 'DELETE' && url.pathname.startsWith('/outbox/')) {
        const id = url.pathname.slice('/outbox/'.length);
        const outboxDir = path.join(ctx.workspacePath, 'outbox');
        const filePath = path.join(outboxDir, `${id}.json`);

        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'not found' }));
        }
        return;
      }

      // 404
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  server.listen(port, () => {
    console.log(`[server] listening on http://localhost:${port}`);
  });

  return server;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function readOutbox(outboxDir: string): OutboxMessage[] {
  if (!fs.existsSync(outboxDir)) return [];
  const files = fs.readdirSync(outboxDir).filter((f) => f.endsWith('.json'));
  return files.map((f) => {
    const content = fs.readFileSync(path.join(outboxDir, f), 'utf-8');
    return JSON.parse(content) as OutboxMessage;
  });
}

interface ToolDetail {
  name: string;
  args: string; // compact arg summary
}

interface HistorySummary {
  round: number;
  timestamp: number;
  provider: string;
  model?: string;
  messageCount: number;
  toolCallCount: number;
  toolNames: string[];
  tools: ToolDetail[];
  userPreview: string;
  assistantPreview: string;
  usage?: { input: number; output: number };
}

function readHistoryList(
  workspacePath: string,
  offset: number,
  limit: number
): { items: HistorySummary[]; total: number; offset: number; limit: number } {
  const dir = path.join(workspacePath, 'history');
  if (!fs.existsSync(dir)) return { items: [], total: 0, offset, limit };

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('round-') && f.endsWith('.json'))
    .sort()
    .reverse(); // newest first

  const total = files.length;
  const sliced = files.slice(offset, offset + limit);

  const items: HistorySummary[] = sliced.map((f) => {
    const content = fs.readFileSync(path.join(dir, f), 'utf-8');
    const snapshot = JSON.parse(content);
    const toolCalls = snapshot.response?.toolCalls ?? [];
    const toolNames: string[] = [...new Set(toolCalls.map((tc: { name: string }) => tc.name) as string[])];

    // Compact tool summaries: name + short arg string
    const tools: ToolDetail[] = toolCalls.map((tc: { name: string; args?: Record<string, unknown> }) => {
      const a = tc.args ?? {};
      let args: string;
      if (tc.name === 'bash') args = String(a.command ?? '').slice(0, 100);
      else if (tc.name === 'write_file') args = String(a.path ?? '');
      else if (tc.name === 'read_file') args = String(a.path ?? '');
      else if (tc.name === 'reply') args = `→ ${String(a.source ?? '')}`;
      else if (tc.name === 'bash_kill') args = String(a.id ?? '');
      else args = Object.keys(a).length ? JSON.stringify(a).slice(0, 80) : '';
      return { name: tc.name, args };
    });

    const msgs = snapshot.messages ?? [];
    const userMsg = msgs.find(
      (m: { role: string; content?: string }) => m.role === 'user' && m.content
    );
    const userPreview = userMsg?.content?.slice(0, 120) ?? '';

    // Assistant content (text response, if any)
    const assistantMsg = msgs.find(
      (m: { role: string; content?: string | null }) => m.role === 'assistant' && m.content
    );
    const assistantPreview = (assistantMsg?.content ?? snapshot.response?.content ?? '').slice(0, 200);

    return {
      round: snapshot.round,
      timestamp: snapshot.timestamp,
      provider: snapshot.provider,
      model: snapshot.model,
      messageCount: msgs.length,
      toolCallCount: toolCalls.length,
      toolNames,
      tools,
      userPreview,
      assistantPreview,
      usage: snapshot.response?.usage,
    };
  });

  return { items, total, offset, limit };
}

function readHistoryDetail(workspacePath: string, round: number): unknown | null {
  const filename = `round-${String(round).padStart(5, '0')}.json`;
  const filePath = path.join(workspacePath, 'history', filename);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function writeOutbox(workspacePath: string, msg: { source: string; content: string; metadata?: Record<string, unknown> }): OutboxMessage {
  const outboxDir = path.join(workspacePath, 'outbox');
  if (!fs.existsSync(outboxDir)) fs.mkdirSync(outboxDir, { recursive: true });

  const outMsg: OutboxMessage = {
    id: crypto.randomUUID(),
    source: msg.source,
    content: msg.content,
    metadata: msg.metadata,
    timestamp: Date.now(),
  };

  fs.writeFileSync(path.join(outboxDir, `${outMsg.id}.json`), JSON.stringify(outMsg, null, 2));
  console.log(`[outbox] reply → ${msg.source}: ${msg.content.slice(0, 80)}...`);
  return outMsg;
}
