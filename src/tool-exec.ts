import fs from 'node:fs';
import path from 'node:path';
import { writeOutbox } from './server.js';
import type { Message, ToolScript } from './types.js';

export interface ToolCallResult {
  messages: Message[];
  shouldWait: boolean;
}

export async function executeToolCall(
  call: { id: string; name: string; args: unknown },
  userTools: ToolScript[],
  workspacePath: string
): Promise<ToolCallResult> {
  console.log(`[tool] ${call.name}(${JSON.stringify(call.args).slice(0, 80)})`);

  if (call.name === 'think') {
    console.log(`[think] ${String((call.args as Record<string, unknown>)?.thought ?? '').slice(0, 120)}`);
    return { messages: [{ role: 'tool', content: 'OK', toolCallId: call.id }], shouldWait: false };
  }

  if (call.name === 'reply') {
    const args = call.args as Record<string, unknown>;
    const replySource = String(args.source ?? '');
    const replyContent = String(args.content ?? '');
    try {
      await deliverReply(workspacePath, replySource, replyContent);
      console.log(`[reply] → ${replySource}: ${replyContent.slice(0, 80)}`);
      return { messages: [{ role: 'tool', content: `Reply delivered to ${replySource}`, toolCallId: call.id }], shouldWait: false };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[reply] delivery error: ${errMsg}`);
      return { messages: [{ role: 'tool', content: `ERROR delivering reply: ${errMsg}`, toolCallId: call.id }], shouldWait: false };
    }
  }

  if (call.name === 'wait_for') {
    return { messages: [{ role: 'tool', content: 'Entering wait state. Will resume when new messages arrive.', toolCallId: call.id }], shouldWait: true };
  }

  // User-defined tool
  const tool = userTools.find((t) => t.name === call.name);
  if (!tool) {
    return { messages: [{ role: 'tool', content: `ERROR: unknown tool "${call.name}"`, toolCallId: call.id }], shouldWait: false };
  }

  try {
    const result = await tool.execute(call.args);
    return {
      messages: [{ role: 'tool', content: result.result, toolCallId: call.id }],
      shouldWait: result.action === 'wait',
    };
  } catch (toolError) {
    const errMsg = toolError instanceof Error ? toolError.message : String(toolError);
    console.error(`[tool] ${call.name} error: ${errMsg}`);
    return { messages: [{ role: 'tool', content: `ERROR: ${errMsg}`, toolCallId: call.id }], shouldWait: false };
  }
}

/**
 * Load delivery routes from routes.json.
 */
function loadRoutes(workspacePath: string): Record<string, { url: string }> {
  const routesPath = path.join(workspacePath, 'routes.json');
  try {
    const content = fs.readFileSync(routesPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * Route a reply to the appropriate destination.
 * Looks up source prefix in routes.json → POST to registered URL.
 * Falls back to outbox if no route matches.
 */
async function deliverReply(workspacePath: string, source: string, content: string): Promise<void> {
  const routes = loadRoutes(workspacePath);

  const colonIdx = source.indexOf(':');
  const prefix = colonIdx > 0 ? source.slice(0, colonIdx) : source;

  const route = routes[prefix];
  if (route?.url) {
    const res = await fetch(route.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, content }),
    });
    if (!res.ok) {
      throw new Error(`Route POST to ${route.url} failed: ${res.status} ${await res.text()}`);
    }
    return;
  }

  // Default: write to outbox
  writeOutbox(workspacePath, { source, content });
}
