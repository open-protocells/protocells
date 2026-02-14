#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startAdmin } from './admin.js';

const workspacePath = path.resolve(process.argv[2] ?? './workspace');
const agentPort = parseInt(process.env.PORT ?? '3010', 10);
const adminPort = parseInt(process.env.ADMIN_PORT ?? '3001', 10);

console.log(`[index] workspace: ${workspacePath}`);
console.log(`[index] root agent port: ${agentPort}, admin port: ${adminPort}`);

// 1. Start admin dashboard
const adminServer = startAdmin({ agentPort, workspacePath, port: adminPort });

// 2. Spawn root agent as child process
const distDir = path.dirname(fileURLToPath(import.meta.url));
const agentScript = path.join(distDir, 'agent.js');

const agent = spawn('node', [agentScript, workspacePath], {
  env: {
    ...process.env,
    PORT: String(agentPort),
  },
  stdio: 'inherit',
});

agent.on('exit', (code, signal) => {
  console.error(`[index] root agent exited: code=${code} signal=${signal}`);
  process.exit(code ?? 1);
});

process.on('SIGTERM', () => {
  agent.kill('SIGTERM');
  adminServer.close();
});

// 3. Wait for agent ready, register admin route
(async () => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${agentPort}/status`);
      if (res.ok) break;
    } catch {
      // Agent not ready yet
    }
    await new Promise(r => setTimeout(r, 500));
  }
  const routesPath = path.join(workspacePath, 'routes.json');
  try {
    const routes = JSON.parse(fs.readFileSync(routesPath, 'utf-8'));
    routes['admin'] = { url: `http://localhost:${adminPort}/api/reply` };
    fs.writeFileSync(routesPath, JSON.stringify(routes, null, 2));
    console.log('[index] admin route registered');
  } catch (err) {
    console.error('[index] failed to register admin route:', err);
  }
})();
