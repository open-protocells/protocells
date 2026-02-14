import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentState } from './types.js';

/** Resolve the roles/ directory relative to the app root */
export function getRolesDir(): string {
  const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  return path.join(appDir, 'roles');
}

/** Recursively copy all files from src dir into dest dir (merges, does not clear) */
export function copyDirRecursive(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Base system prompt — shared by all roles (no role-specific content)
const BASE_SYSTEM_PROMPT = `You are a helpful AI agent running as a persistent process inside a Linux container. You communicate through a message queue.

Messages are prefixed with [source] indicating origin.

## Delivering replies

Your text output is NOT delivered to users. You MUST use the reply tool:

reply({ source: "the-source", content: "your message" })

Copy the source exactly from the [source] prefix of the incoming message. The system handles routing automatically.

After delivering, call wait_for to sleep unless you have more work to do.

## Core principles

1. NEVER fabricate information. If you don't know something, say so. If you can verify it, verify it FIRST, then answer.
2. You have bash with full internet access (curl, etc.). USE IT to verify facts before answering.
3. Be direct and concise.
4. Use your tools proactively.
5. When you receive a task, use reply() FIRST to acknowledge it and briefly explain your plan, BEFORE starting the work. During multi-step work, send progress updates via reply() every 2-3 tool calls — never do more than 3 tool calls without updating the user.

## Message Notifications

When you receive a message notification (e.g., "[slack] 新消息 in XXX"), it means a user sent you a message. You MUST:
1. Read the message via the API
2. Reply directly to the user with your response

Do NOT tell the user "you received a notification". Just read the message and reply.

## Tools

Built-in:
- think: Reason and plan internally. ALWAYS use this instead of text output.
- reply: Send a message to the user. The ONLY way users can see your messages.
- wait_for: Pause until new messages arrive.

User-defined: bash, read_file, write_file, list_files

IMPORTANT: NEVER output plain text. All actions must go through tools. Use think() to reason, reply() to talk to users, wait_for() to sleep.

## Skills

The skills/ directory contains instructions for specific scenarios. Read it when unsure how to handle something.

## Self-configuration

You can inspect and modify your own configuration and behavior:
- \`agent.json\` — Your runtime config. Read it to understand your current setup, modify it to change settings like model.
- \`scripts/providers/\` — LLM provider adapters.
- \`scripts/tools/\` — Your tool implementations. You can modify existing tools or create new ones.

When asked about your config or capabilities, read the relevant files first rather than guessing.`;

export function initWorkspace(workspacePath: string, role: string = 'worker'): void {
  if (fs.existsSync(path.join(workspacePath, 'agent.json'))) {
    console.log(`[init] workspace already exists at ${workspacePath}`);
    return;
  }

  console.log(`[init] creating workspace at ${workspacePath} (role: ${role})`);

  const rolesDir = getRolesDir();

  // 1. Create base directories
  for (const dir of ['scripts/providers', 'scripts/tools', 'skills', 'memory', 'history', 'outbox']) {
    fs.mkdirSync(path.join(workspacePath, dir), { recursive: true });
  }

  // 2. Copy _base template (shared scripts, tools, common skills)
  const baseDir = path.join(rolesDir, '_base');
  if (fs.existsSync(baseDir)) {
    copyDirRecursive(baseDir, workspacePath);
  }

  // 3. Copy role-specific template (skills + prompt.md)
  const roleDir = path.join(rolesDir, role);
  if (fs.existsSync(roleDir)) {
    // Copy role skills into workspace skills/
    const roleSkills = path.join(roleDir, 'skills');
    if (fs.existsSync(roleSkills)) {
      copyDirRecursive(roleSkills, path.join(workspacePath, 'skills'));
    }
    // Copy prompt.md to workspace root
    const promptSrc = path.join(roleDir, 'prompt.md');
    if (fs.existsSync(promptSrc)) {
      fs.copyFileSync(promptSrc, path.join(workspacePath, 'prompt.md'));
    }
  }

  // 4. Generate agent.json (dynamic: provider auto-detection)
  const defaultProvider = process.env.MINIMAX_API_KEY ? 'minimax'
    : process.env.OPENAI_API_KEY ? 'openai'
    : 'anthropic';
  const defaultModels: Record<string, string> = {
    anthropic: 'claude-sonnet-4-20250514',
    openai: 'gpt-4o',
    minimax: 'MiniMax-M2.5',
  };
  const agentState: AgentState = {
    provider: defaultProvider,
    model: defaultModels[defaultProvider],
    round: 0,
    maxRounds: 1000,
    role,
    systemPrompt: BASE_SYSTEM_PROMPT,
  };
  fs.writeFileSync(
    path.join(workspacePath, 'agent.json'),
    JSON.stringify(agentState, null, 2)
  );

  // 5. Initialize config files
  fs.writeFileSync(path.join(workspacePath, 'routes.json'), '{}');
  fs.writeFileSync(path.join(workspacePath, 'memory/context.json'), '[]');

  console.log('[init] workspace created successfully');
}
