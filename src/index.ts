#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initWorkspace } from './init.js';
import { MessageQueue } from './queue.js';
import { createServer } from './server.js';
import { executeLoop, type ExecutorState } from './executor.js';
import { loadState } from './state.js';

const workspacePath = path.resolve(process.argv[2] ?? './workspace');
const port = parseInt(process.env.PORT ?? '3000', 10);
process.env.WORKSPACE = workspacePath;

console.log(`[protocells] workspace: ${workspacePath}`);
console.log(`[protocells] port: ${port}`);

// Initialize workspace if needed
initWorkspace(workspacePath);

// Ensure workspace scripts can resolve npm packages via ESM import()
// by symlinking workspace/node_modules → app's node_modules
const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appNodeModules = path.join(appDir, 'node_modules');
const wsNodeModules = path.join(workspacePath, 'node_modules');
if (fs.existsSync(appNodeModules) && !fs.existsSync(wsNodeModules)) {
  fs.symlinkSync(appNodeModules, wsNodeModules, 'dir');
  console.log(`[protocells] linked ${wsNodeModules} → ${appNodeModules}`);
}

// Create message queue
const queue = new MessageQueue();

// Executor state (shared with server for status endpoint)
const executorState: ExecutorState = { status: 'waiting' };

// Start HTTP server
createServer(
  {
    queue,
    workspacePath,
    getStatus: () => {
      try {
        const state = loadState(workspacePath);
        return {
          status: executorState.status,
          round: state.round,
          provider: state.provider,
          model: state.model,
        };
      } catch {
        return { status: executorState.status, round: 0, provider: 'unknown' };
      }
    },
  },
  port
);

// Run skill setup scripts
const skillsDir = path.join(workspacePath, 'skills');
if (fs.existsSync(skillsDir)) {
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const setupScript = path.join(skillsDir, entry.name, 'setup.sh');
    if (!fs.existsSync(setupScript)) continue;

    console.log(`[skills] running setup: ${entry.name}/setup.sh`);
    const child = spawn('sh', [setupScript], {
      cwd: path.join(skillsDir, entry.name),
      env: { ...process.env, AGENT_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d: Buffer) => process.stdout.write(`[${entry.name}] ${d}`));
    child.stderr.on('data', (d: Buffer) => process.stderr.write(`[${entry.name}] ${d}`));
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`[skills] ${entry.name}/setup.sh exited with code ${code}`);
      }
    });
  }
}

// Start executor loop
console.log('[protocells] starting agent loop, waiting for first message...');
executeLoop(workspacePath, queue, executorState).catch((err) => {
  console.error('[protocells] fatal error:', err);
  process.exit(1);
});
