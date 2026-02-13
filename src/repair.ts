import fs from 'node:fs';
import path from 'node:path';
import { loadRepairConfig } from './state.js';
import { testLoadAllScripts } from './loader.js';
import { executeToolCall } from './tool-exec.js';
import type { ProviderScript, ToolDef, ToolScript, Message } from './types.js';

const MAX_REPAIR_ROUNDS = 10;

export interface RepairOptions {
  workspacePath: string;
  error: Error;
  provider: ProviderScript;
  model: string;
  userTools: ToolScript[];
  builtinToolDefs: ToolDef[];
}

export async function repair(opts: RepairOptions): Promise<void> {
  const { workspacePath, error, provider, model, userTools, builtinToolDefs } = opts;
  console.log(`[repair] entering repair mode: ${error.message}`);

  const config = loadRepairConfig(workspacePath);

  // All tools = builtin + user tools (same capabilities as main agent)
  const allToolDefs: ToolDef[] = [
    ...builtinToolDefs,
    ...userTools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  ];

  // Load persistent repair context (memory across repair sessions)
  const context = loadRepairContext();

  // Inject error info
  const scriptList = listScriptsRecursive(path.join(workspacePath, 'scripts'));
  context.push({
    role: 'user',
    content: `[system:repair] The main agent encountered an error and cannot continue. Please diagnose and fix the issue.\n\nError: ${error.message}\n\nStack: ${error.stack}\n\nAvailable scripts:\n${scriptList.join('\n')}`,
  });

  for (let round = 0; round < MAX_REPAIR_ROUNDS; round++) {
    console.log(`[repair] round ${round + 1}/${MAX_REPAIR_ROUNDS}`);

    // Build messages with repair system prompt
    const messages: Message[] = [
      { role: 'system', content: config.systemPrompt },
      ...context,
    ];

    const response = await provider.chat(messages, allToolDefs, { model });

    // Append assistant message to context
    context.push({
      role: 'assistant',
      content: response.content,
      toolCalls: response.toolCalls ?? undefined,
    });

    if (response.content) {
      console.log(`[repair] ${response.content.slice(0, 120)}${response.content.length > 120 ? '...' : ''}`);
    }

    // Execute tool calls in parallel (same as main agent)
    if (response.toolCalls) {
      const results = await Promise.all(
        response.toolCalls.map((call) => executeToolCall(call, userTools, workspacePath))
      );

      for (const result of results) {
        context.push(...result.messages);
      }
    }

    // Save context to disk (persistent memory)
    saveRepairContext(context);

    // Save round history
    saveRepairHistory(round, context, response);

    // Verify: try loading all scripts
    try {
      await testLoadAllScripts(workspacePath);
      console.log('[repair] scripts fixed successfully, returning to main agent');
      return;
    } catch (stillBroken) {
      const msg = stillBroken instanceof Error ? stillBroken.message : String(stillBroken);
      console.log(`[repair] scripts still broken: ${msg}`);
      context.push({
        role: 'user',
        content: `[system:repair] Scripts still broken after your changes:\n${msg}\n\nPlease try again.`,
      });
    }
  }

  // Save final context even on failure
  saveRepairContext(context);
  throw new Error(`[repair] failed after ${MAX_REPAIR_ROUNDS} rounds`);
}

// ---- Repair context persistence ----

const REPAIR_DIR = '/.repair';

function repairContextPath(): string {
  return path.join(REPAIR_DIR, 'context.json');
}

function loadRepairContext(): Message[] {
  const filePath = repairContextPath();
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return [];
  }
}

function saveRepairContext(context: Message[]): void {
  const filePath = repairContextPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(context, null, 2));
}

function saveRepairHistory(round: number, context: Message[], response: unknown): void {
  const dir = path.join(REPAIR_DIR, 'history');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filename = `repair-${String(round).padStart(5, '0')}.json`;
  fs.writeFileSync(path.join(dir, filename), JSON.stringify({
    round,
    timestamp: Date.now(),
    messages: context,
    response,
  }, null, 2));
}

// ---- Helpers ----

function listScriptsRecursive(dir: string, prefix = ''): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      result.push(...listScriptsRecursive(path.join(dir, entry.name), rel));
    } else {
      result.push(rel);
    }
  }
  return result;
}
