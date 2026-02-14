import fs from 'node:fs';
import path from 'node:path';
import { loadProvider, loadTools, testLoadAllScripts } from './loader.js';
import { loadState, saveState } from './state.js';
import { loadContext, saveContext, shouldCompress, compressContext, pruneContext } from './memory.js';
import { saveHistory } from './history.js';
import { executeToolCall } from './tool-exec.js';
import type { MessageQueue } from './queue.js';
import type { Message, ProviderScript, ToolScript, ToolDef } from './types.js';

export type ExecutorStatus = 'running' | 'waiting' | 'error';

export interface ExecutorState {
  status: ExecutorStatus;
  error?: {
    message: string;
    stack?: string;
    timestamp: number;
    source: string;
  };
}

// ---- Error handling helpers ----

async function notifyRepairAgent(error: Error, source: string): Promise<void> {
  const repairUrl = process.env.REPAIR_AGENT_URL;
  if (!repairUrl) return;
  await fetch(`${repairUrl}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: `repair:worker`,
      content: `Agent error [${source}]: ${error.message}\nStack: ${error.stack}`,
    }),
  }).catch(() => {});
}

async function waitForExternalRepair(
  workspacePath: string,
  executorState: ExecutorState,
  pollMs: number = 15_000,
  maxMs: number = 600_000,
): Promise<void> {
  console.log('[executor] waiting for external repair...');
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    // Check for repair signal file
    const signalPath = path.join(workspacePath, '.repair-signal');
    if (fs.existsSync(signalPath)) {
      fs.unlinkSync(signalPath);
      console.log('[executor] repair signal detected, resuming');
      executorState.status = 'running';
      executorState.error = undefined;
      return;
    }
    // Also try loading scripts (may have been fixed manually)
    try {
      await testLoadAllScripts(workspacePath);
      console.log('[executor] scripts appear fixed, resuming');
      executorState.status = 'running';
      executorState.error = undefined;
      return;
    } catch {
      // Still broken
    }
  }
  throw new Error('no external repair within timeout');
}

async function enterErrorState(
  workspacePath: string,
  executorState: ExecutorState,
  error: Error,
  source: string,
): Promise<void> {
  executorState.status = 'error';
  executorState.error = {
    message: error.message,
    stack: error.stack,
    timestamp: Date.now(),
    source,
  };
  console.error(`[executor] entering error state [${source}]: ${error.message}`);
  await notifyRepairAgent(error, source);
  await waitForExternalRepair(workspacePath, executorState);
}

// ---- Main executor loop ----

export async function executeLoop(
  workspacePath: string,
  queue: MessageQueue,
  executorState: ExecutorState
): Promise<void> {
  // Built-in tool definitions (not modifiable by agent)
  const builtinToolDefs: ToolDef[] = [
    {
      name: 'think',
      description: 'Use this tool to think and reason step-by-step. Put your internal reasoning, planning, and analysis in the `thought` parameter. This is NOT visible to users. Always use this tool instead of outputting text when you need to think.',
      parameters: {
        type: 'object',
        properties: {
          thought: { type: 'string', description: 'Your internal reasoning and thought process' },
        },
        required: ['thought'],
      },
    },
    {
      name: 'reply',
      description: 'Send a reply to a message source. This is the ONLY way to deliver messages to users. The system routes the reply based on the source prefix.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'The source to reply to, copied from the [source] prefix of the incoming message' },
          content: { type: 'string', description: 'The reply content' },
        },
        required: ['source', 'content'],
      },
    },
    {
      name: 'wait_for',
      description: 'Enter waiting state. The agent will pause until new messages arrive in the queue.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  ];

  // Wait for first message before entering the loop
  console.log('[executor] entering wait state...');
  executorState.status = 'waiting';
  await queue.waitForMessage();
  console.log('[executor] woke up, new messages available');

  let noToolRetries = 0;

  while (true) {
    try {
      // Load state from disk
      const state = loadState(workspacePath);

      // Check max rounds
      if (state.maxRounds && state.round >= state.maxRounds) {
        console.log(`[executor] reached max rounds (${state.maxRounds}), stopping`);
        break;
      }

      // Load user scripts
      let provider: ProviderScript;
      let userTools: ToolScript[];

      try {
        executorState.status = 'running';
        const providerPath = path.join(workspacePath, 'scripts', 'providers', `${state.provider}.js`);
        provider = await loadProvider(providerPath);
        userTools = await loadTools(path.join(workspacePath, 'scripts', 'tools'));
      } catch (loadError) {
        const err = loadError instanceof Error ? loadError : new Error(String(loadError));
        await enterErrorState(workspacePath, executorState, err, 'script_load');
        continue;
      }

      // Merge tool definitions
      const allToolDefs: ToolDef[] = [
        ...builtinToolDefs,
        ...userTools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      ];

      console.log(`[executor] round ${state.round}: starting`);

      // Drain queue
      const queueMessages = queue.drain();
      const context = loadContext(workspacePath);

      // Track this round's new messages for history (independent of context mutations)
      const roundMessages: Message[] = [];

      for (const msg of queueMessages) {
        const userMsg: Message = {
          role: 'user',
          content: `[${msg.source}] ${msg.content}`,
        };
        context.push(userMsg);
        roundMessages.push(userMsg);
      }

      // Persist queue messages immediately to prevent loss on crash
      if (queueMessages.length > 0) {
        saveContext(workspacePath, context);
      }

      // Layer 1: Pruning — trim old tool results (cheap, reduces size without losing messages)
      let currentContext = pruneContext(context);

      // Persist pruned context so it doesn't re-inflate on next load
      if (currentContext !== context) {
        saveContext(workspacePath, currentContext);
      }

      // Layer 3: Compaction — if still too large after pruning, summarize old messages
      if (shouldCompress(currentContext)) {
        try {
          currentContext = await compressContext(currentContext, provider, allToolDefs, workspacePath);
          saveContext(workspacePath, currentContext);
        } catch (err) {
          console.error(`[executor] compaction failed, continuing with full context: ${err}`);
        }
      }

      const prunedContext = currentContext;

      // Call LLM (with retry for transient failures)
      let response: import('./types.js').LLMResponse | undefined;

      // Read role-specific prompt (prompt.md in workspace root)
      let rolePrompt = '';
      const promptPath = path.join(workspacePath, 'prompt.md');
      if (fs.existsSync(promptPath)) {
        rolePrompt = fs.readFileSync(promptPath, 'utf-8');
      }

      const systemContent = state.systemPrompt
        + (rolePrompt ? '\n\n' + rolePrompt : '')
        + `\n\nYour workspace directory is: ${workspacePath}\nAlways use absolute paths (e.g. ${workspacePath}/skills/) when accessing files.`;
      const llmMessages: Message[] = [
        { role: 'system', content: systemContent },
        ...prunedContext,
      ];

      console.log(`[executor] round ${state.round}: calling LLM (${state.provider}/${state.model}, ${prunedContext.length} messages)`);

      let llmError: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await provider.chat(llmMessages, allToolDefs, { model: state.model });
          llmError = null;
          break;
        } catch (err) {
          llmError = err;
          if (attempt < 2) {
            const delay = (attempt + 1) * 2000; // 2s, 4s
            console.error(`[executor] LLM call failed (attempt ${attempt + 1}/3), retrying in ${delay}ms: ${err}`);
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }

      if (llmError) {
        const err = llmError instanceof Error ? llmError : new Error(String(llmError));
        await enterErrorState(workspacePath, executorState, err, 'llm_call');
        continue;
      }

      // Append assistant message (response guaranteed set here — llmError check above continues/throws)
      const llmResponse = response!;
      const assistantMsg: Message = {
        role: 'assistant',
        content: llmResponse.content,
        toolCalls: llmResponse.toolCalls ?? undefined,
      };
      currentContext.push(assistantMsg);
      roundMessages.push(assistantMsg);

      if (llmResponse.content) {
        console.log(`[agent] ${llmResponse.content.slice(0, 120)}${llmResponse.content.length > 120 ? '...' : ''}`);
      }

      // Execute tool calls in parallel
      let shouldWait = false;

      if (llmResponse.toolCalls) {
        console.log(`[executor] round ${state.round}: executing ${llmResponse.toolCalls.length} tool call(s): ${llmResponse.toolCalls.map(tc => tc.name).join(', ')}`);
        const results = await Promise.all(
          llmResponse.toolCalls.map((call) => executeToolCall(call, userTools, workspacePath))
        );

        for (const result of results) {
          currentContext.push(...result.messages);
          roundMessages.push(...result.messages);
          if (result.shouldWait) shouldWait = true;
        }
      }

      // Save to disk
      saveContext(workspacePath, currentContext);
      // History only stores this round's new messages (not the full context)
      saveHistory(workspacePath, {
        round: state.round,
        timestamp: Date.now(),
        messages: roundMessages,
        response: llmResponse,
        provider: state.provider,
        model: state.model,
      });

      // Re-read state from disk before saving, in case the agent modified it (e.g. changed model)
      const freshState = loadState(workspacePath);
      freshState.round = state.round + 1;
      saveState(workspacePath, freshState);

      // If agent produced no tool calls, nudge it to use tools
      if (!llmResponse.toolCalls) {
        noToolRetries++;
        if (noToolRetries <= 2) {
          console.log(`[executor] no tool calls (retry ${noToolRetries}/2), nudging agent`);
          currentContext.push({
            role: 'user',
            content: '[system] You did not call any tools. You MUST use tools for everything: think() to reason, reply() to send messages to users, wait_for() to sleep. Plain text output is discarded. Try again.',
          });
          continue;
        }
        console.log('[executor] no tool calls after retries, entering wait state');
        noToolRetries = 0;
      } else {
        noToolRetries = 0;
      }

      // Wait if needed
      if (shouldWait) {
        console.log('[executor] entering wait state...');
        executorState.status = 'waiting';
        await queue.waitForMessage();
        console.log('[executor] woke up, new messages available');
      }
    } catch (err) {
      // Catch-all: any unhandled error in the round
      const error = err instanceof Error ? err : new Error(String(err));
      await enterErrorState(workspacePath, executorState, error, 'unknown');
      continue;
    }
  }
}
