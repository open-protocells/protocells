import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { MessageQueue } from './queue.js';
import type { OutboxMessage } from './types.js';

export interface ServerContext {
  queue: MessageQueue;
  workspacePath: string;
  getStatus: () => { status: string; round: number; provider: string; model?: string };
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

      // GET /outbox
      if (req.method === 'GET' && url.pathname === '/outbox') {
        const outboxDir = path.join(ctx.workspacePath, 'outbox');
        const messages = readOutbox(outboxDir);
        res.writeHead(200);
        res.end(JSON.stringify(messages));
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
