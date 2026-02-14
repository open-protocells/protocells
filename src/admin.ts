import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface AdminConfig {
  agentPort: number;
  workspacePath: string;
  port?: number;
}

interface Session {
  sseRes: http.ServerResponse | null;
  messages: { role: string; content: string; timestamp: number }[];
}

const sessions = new Map<string, Session>();

function getOrCreateSession(id: string): Session {
  if (!sessions.has(id)) sessions.set(id, { sseRes: null, messages: [] });
  return sessions.get(id)!;
}

function pushSSE(sessionId: string, event: string, data: unknown): void {
  const s = sessions.get(sessionId);
  if (s?.sseRes && !s.sseRes.destroyed) {
    s.sseRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

/**
 * Discover agents from routes.json + the local agent port.
 */
function discoverAgents(config: AdminConfig): { name: string; url: string }[] {
  const agents: { name: string; url: string }[] = [
    { name: 'root', url: `http://localhost:${config.agentPort}` },
  ];

  const routesPath = path.join(config.workspacePath, 'routes.json');
  try {
    const routes = JSON.parse(fs.readFileSync(routesPath, 'utf-8'));
    for (const [prefix, route] of Object.entries(routes)) {
      if (prefix === 'admin') continue;
      const r = route as { url: string };
      if (r.url?.includes('/message')) {
        const baseUrl = r.url.replace('/message', '');
        agents.push({ name: prefix, url: baseUrl });
      }
    }
  } catch {
    // routes.json may not exist yet
  }

  return agents;
}

function getSystemInfo(): Record<string, unknown> {
  const mem = process.memoryUsage();
  let disk = 'unknown';
  let processes = 'unknown';
  try {
    disk = execSync('df -h /workspace 2>/dev/null || df -h /', { encoding: 'utf-8', timeout: 5_000 }).trim();
  } catch { /* ignore */ }
  try {
    processes = execSync('ps aux --sort=-rss 2>/dev/null || ps aux', { encoding: 'utf-8', timeout: 5_000 }).trim();
  } catch { /* ignore */ }

  return {
    memory: {
      system: {
        total: os.totalmem(),
        free: os.freemem(),
        used: os.totalmem() - os.freemem(),
      },
      process: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
      },
    },
    disk,
    processes,
    uptime: {
      process: process.uptime(),
      system: os.uptime(),
    },
    platform: {
      arch: os.arch(),
      platform: os.platform(),
      nodeVersion: process.version,
      cpus: os.cpus().length,
    },
  };
}

const DIST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'admin-ui');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function serveStatic(res: http.ServerResponse, filePath: string): boolean {
  try {
    const resolved = path.resolve(DIST_DIR, filePath);
    if (!resolved.startsWith(DIST_DIR)) { res.writeHead(403); res.end(); return true; }
    const data = fs.readFileSync(resolved);
    const ext = path.extname(resolved);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
    res.end(data);
    return true;
  } catch { return false; }
}

export function startAdmin(config: AdminConfig): http.Server {
  const port = config.port ?? 3001;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    try {
      // GET /api/events?session=X → SSE
      if (req.method === 'GET' && url.pathname === '/api/events') {
        const sid = url.searchParams.get('session');
        if (!sid) { res.writeHead(400); res.end('session required'); return; }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        res.write(':ok\n\n');

        const session = getOrCreateSession(sid);
        session.sseRes = res;

        for (const msg of session.messages) {
          res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
        }

        req.on('close', () => { if (session.sseRes === res) session.sseRes = null; });
        return;
      }

      // POST /api/send → User sends message
      if (req.method === 'POST' && url.pathname === '/api/send') {
        const body = JSON.parse(await readBody(req));
        const { session: sid, content, agent } = body;
        if (!sid || !content) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'session and content required' }));
          return;
        }

        const session = getOrCreateSession(sid);
        const userMsg = { role: 'user', content, timestamp: Date.now() };
        session.messages.push(userMsg);
        pushSSE(sid, 'message', userMsg);

        // Determine target agent URL
        const agents = discoverAgents(config);
        let targetUrl = `http://localhost:${config.agentPort}`;
        if (agent) {
          const found = agents.find(a => a.name === agent);
          if (found) targetUrl = found.url;
        }

        // Forward to agent
        const source = `admin:${sid}`;
        const agentRes = await fetch(`${targetUrl}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, source }),
        });
        const result = await agentRes.json();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, messageId: (result as Record<string, unknown>).messageId }));
        return;
      }

      // POST /api/reply → Agent sends reply
      if (req.method === 'POST' && url.pathname === '/api/reply') {
        const body = JSON.parse(await readBody(req));
        const { source, content } = body;

        const match = source?.match(/^admin:(.+)$/);
        if (!match) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid source' }));
          return;
        }

        const sid = match[1];
        const session = getOrCreateSession(sid);
        const agentMsg = { role: 'assistant', content, timestamp: Date.now() };
        session.messages.push(agentMsg);
        pushSSE(sid, 'message', agentMsg);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // GET /api/messages?session=X → Fetch session messages (for testing)
      if (req.method === 'GET' && url.pathname === '/api/messages') {
        const sid = url.searchParams.get('session');
        if (!sid) { res.writeHead(400); res.end('session required'); return; }
        const session = sessions.get(sid);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(session ? session.messages : []));
        return;
      }

      // GET /api/agents → List all known agents with status
      if (req.method === 'GET' && url.pathname === '/api/agents') {
        const agents = discoverAgents(config);
        const results = await Promise.all(
          agents.map(async (a) => {
            try {
              const r = await fetch(`${a.url}/status`, { signal: AbortSignal.timeout(3000) });
              const status = await r.json();
              return { ...a, status, online: true };
            } catch {
              return { ...a, status: null, online: false };
            }
          })
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(results));
        return;
      }

      // GET /api/system-info → System monitoring data
      if (req.method === 'GET' && url.pathname === '/api/system-info') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getSystemInfo()));
        return;
      }

      // GET /api/history?agent=root&offset=0&limit=20 → proxy to agent
      if (req.method === 'GET' && url.pathname === '/api/history') {
        const agentName = url.searchParams.get('agent') ?? 'root';
        const offset = url.searchParams.get('offset') ?? '0';
        const limit = url.searchParams.get('limit') ?? '20';

        const agents = discoverAgents(config);
        const agent = agents.find((a) => a.name === agentName);
        if (!agent) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `agent "${agentName}" not found` }));
          return;
        }

        try {
          const agentRes = await fetch(
            `${agent.url}/history?offset=${offset}&limit=${limit}`,
            { signal: AbortSignal.timeout(10_000) }
          );
          const data = await agentRes.text();
          res.writeHead(agentRes.status, { 'Content-Type': 'application/json' });
          res.end(data);
        } catch (err) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `failed to fetch history: ${err}` }));
        }
        return;
      }

      // GET /api/history/:round?agent=root → proxy to agent
      if (req.method === 'GET' && /^\/api\/history\/\d+$/.test(url.pathname)) {
        const round = url.pathname.split('/').pop();
        const agentName = url.searchParams.get('agent') ?? 'root';

        const agents = discoverAgents(config);
        const agent = agents.find((a) => a.name === agentName);
        if (!agent) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `agent "${agentName}" not found` }));
          return;
        }

        try {
          const agentRes = await fetch(
            `${agent.url}/history/${round}`,
            { signal: AbortSignal.timeout(10_000) }
          );
          const data = await agentRes.text();
          res.writeHead(agentRes.status, { 'Content-Type': 'application/json' });
          res.end(data);
        } catch (err) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `failed to fetch history detail: ${err}` }));
        }
        return;
      }

      // GET /api/status → Admin self status
      if (req.method === 'GET' && url.pathname === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          admin: true,
          port,
          agentPort: config.agentPort,
          sessions: sessions.size,
        }));
        return;
      }

      // Static file serving (SPA fallback)
      if (req.method === 'GET') {
        const filePath = url.pathname.slice(1); // remove leading /
        if (filePath && serveStatic(res, filePath)) return;
        // SPA fallback — serve index.html for all unmatched GET routes
        if (serveStatic(res, 'index.html')) return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (err) {
      console.error('[admin] error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  server.listen(port, () => {
    console.log(`[admin] dashboard at http://localhost:${port}`);
  });

  return server;
}
