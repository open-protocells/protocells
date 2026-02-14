#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initWorkspace, getRolesDir, copyDirRecursive } from './init.js';
import { MessageQueue } from './queue.js';
import { createServer } from './server.js';
import { executeLoop, type ExecutorState } from './executor.js';
import { loadState } from './state.js';
import { loadContext } from './memory.js';

const workspacePath = path.resolve(process.argv[2] ?? './workspace');
const port = parseInt(process.env.PORT ?? '3000', 10);
process.env.WORKSPACE = workspacePath;

// ---- Global crash handlers ----
function writeCrashLog(error: Error, source: string): void {
  try {
    const crashInfo = {
      timestamp: new Date().toISOString(),
      source,
      message: error.message,
      stack: error.stack,
      pid: process.pid,
      workspace: workspacePath,
    };
    const crashPath = path.join(workspacePath, 'crash.log');
    fs.appendFileSync(crashPath, JSON.stringify(crashInfo) + '\n');
    console.error(`[protocells] CRASH [${source}]: ${error.message}`);
    console.error(error.stack);
  } catch {
    console.error(`[protocells] CRASH [${source}]: ${error.message}\n${error.stack}`);
  }
}

process.on('uncaughtException', (error) => {
  writeCrashLog(error, 'uncaughtException');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  writeCrashLog(error, 'unhandledRejection');
  process.exit(1);
});

// Consume SPAWN_WORKER immediately so child processes (bash tool) don't inherit it
const isRootSpawner = process.env.SPAWN_WORKER === 'true';
delete process.env.SPAWN_WORKER;

// Determine role based on SPAWN_WORKER
const role = isRootSpawner ? 'root' : 'worker';

console.log(`[protocells] workspace: ${workspacePath}`);
console.log(`[protocells] port: ${port}`);
console.log(`[protocells] role: ${role}`);

// Initialize workspace with role template
initWorkspace(workspacePath, role);

// Guard: if this is NOT the root agent, clean any inherited root state
// (root agent clones its workspace including agent.json, context.json, and history)
if (!isRootSpawner) {
  const contextPath = path.join(workspacePath, 'memory', 'context.json');
  const statePath = path.join(workspacePath, 'agent.json');
  let inherited = false;

  // Check if context has boot messages from root
  if (fs.existsSync(contextPath)) {
    try {
      const ctx = JSON.parse(fs.readFileSync(contextPath, 'utf-8'));
      if (Array.isArray(ctx) && ctx.some((m: { content?: string }) =>
        typeof m.content === 'string' && m.content.includes('[system:boot]')
      )) {
        inherited = true;
      }
    } catch {}
  }

  // Also check if agent.json has role=root (cloned from root workspace)
  if (!inherited && fs.existsSync(statePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      if (state.role === 'root') {
        inherited = true;
      }
      // Also detect: round > 0 with empty context = freshly cloned
      const ctx = fs.existsSync(contextPath)
        ? JSON.parse(fs.readFileSync(contextPath, 'utf-8'))
        : [];
      if (state.round > 0 && Array.isArray(ctx) && ctx.length <= 1) {
        inherited = true;
      }
    } catch {}
  }

  if (inherited) {
    console.log('[protocells] detected inherited root state, resetting to worker role');
    // Clear context
    fs.writeFileSync(contextPath, '[]');
    // Reset agent state
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      state.round = 0;
      state.role = 'worker';
      // No need to regex-strip systemPrompt — base prompt has no role-specific content
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    } catch {}
    // Overwrite prompt.md with worker role prompt
    const rolesDir = getRolesDir();
    const workerPrompt = path.join(rolesDir, 'worker', 'prompt.md');
    if (fs.existsSync(workerPrompt)) {
      fs.copyFileSync(workerPrompt, path.join(workspacePath, 'prompt.md'));
    }
    // Replace skills with worker role skills (remove root skills, add worker skills)
    const skillsDir = path.join(workspacePath, 'skills');
    if (fs.existsSync(skillsDir)) {
      fs.rmSync(skillsDir, { recursive: true, force: true });
    }
    fs.mkdirSync(skillsDir, { recursive: true });
    const baseSkills = path.join(rolesDir, '_base', 'skills');
    if (fs.existsSync(baseSkills)) {
      copyDirRecursive(baseSkills, skillsDir);
    }
    const workerSkills = path.join(rolesDir, 'worker', 'skills');
    if (fs.existsSync(workerSkills)) {
      copyDirRecursive(workerSkills, skillsDir);
    }
    // Clear history (inherited from root)
    const historyDir = path.join(workspacePath, 'history');
    if (fs.existsSync(historyDir)) {
      for (const f of fs.readdirSync(historyDir)) {
        if (f.startsWith('round-')) {
          fs.unlinkSync(path.join(historyDir, f));
        }
      }
    }
  }
}

// Ensure workspace scripts can resolve npm packages via ESM import()
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
          error: executorState.error,
        };
      } catch {
        return { status: executorState.status, round: 0, provider: 'unknown', error: executorState.error };
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

// Inject boot message if this agent should auto-spawn a worker
if (isRootSpawner) {
  queue.push(
    'System booted. You are the root agent. Follow the spawn-agent skill to spawn a worker sub-agent on port 3000 with workspace /workspace. ' +
    `Set REPAIR_AGENT_URL=http://localhost:${port} in the worker's environment so it can notify you of errors. ` +
    'Do NOT pass SPAWN_WORKER to the child.',
    'system:boot'
  );
}

// Inject restart notification if there's existing context (crash recovery)
if (!isRootSpawner) {
  const existingContext = loadContext(workspacePath);
  if (existingContext.length > 0) {
    // Read crash.log for last crash info
    let crashInfo = '';
    const crashLogPath = path.join(workspacePath, 'crash.log');
    if (fs.existsSync(crashLogPath)) {
      try {
        const lines = fs.readFileSync(crashLogPath, 'utf-8').trim().split('\n');
        const last = JSON.parse(lines[lines.length - 1]);
        crashInfo = ` Last crash: [${last.source}] ${last.message}`;
      } catch {}
    }
    console.log(`[protocells] found existing context (${existingContext.length} messages), injecting restart notification`);
    queue.push(
      `You were restarted after an unexpected shutdown.${crashInfo} Review your context and continue any unfinished work. If there is nothing to continue, call wait_for().`,
      'system:restart'
    );
  }
}

// Start executor loop
console.log('[protocells] starting agent loop, waiting for first message...');
executeLoop(workspacePath, queue, executorState).catch((err) => {
  console.error('[protocells] fatal error:', err);
  process.exit(1);
});
