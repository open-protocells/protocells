import path from 'node:path';
import { loadProvider, loadTools } from './loader.js';
import { loadState, saveState } from './state.js';
import { loadContext, saveContext, shouldCompress, compressContext, pruneContext } from './memory.js';
import { saveHistory } from './history.js';
import { repair } from './repair.js';
import { executeToolCall } from './tool-exec.js';
import type { MessageQueue } from './queue.js';
import type { Message, ProviderScript, ToolScript, ToolDef } from './types.js';

export type ExecutorStatus = 'running' | 'waiting' | 'repairing';

export interface ExecutorState {
  status: ExecutorStatus;
}

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

  // Cache initial state for repair (survives script corruption)
  // Done after first message so external setup (e.g. mock providers) is already in place
  const initialState = loadState(workspacePath);
  const initialProviderPath = path.join(workspacePath, 'scripts', 'providers', `${initialState.provider}.js`);
  const repairProvider = await loadProvider(initialProviderPath);
  const repairTools = await loadTools(path.join(workspacePath, 'scripts', 'tools'));
  const repairModel = initialState.model ?? '';

  let noToolRetries = 0;

  while (true) {
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
      console.error(`[executor] script load error: ${loadError}`);
      executorState.status = 'repairing';
      try {
        await repair({
          workspacePath,
          error: loadError instanceof Error ? loadError : new Error(String(loadError)),
          provider: repairProvider,
          model: state.model ?? repairModel,
          userTools: repairTools,
          builtinToolDefs,
        });
        continue; // Retry after repair
      } catch (repairError) {
        console.error(`[executor] repair failed: ${repairError}`);
        throw repairError;
      }
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

    // Drain queue
    const queueMessages = queue.drain();
    const context = loadContext(workspacePath);

    for (const msg of queueMessages) {
      context.push({
        role: 'user',
        content: `[${msg.source}] ${msg.content}`,
      });
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

    // Call LLM
    let response;
    try {
      const systemContent = `${state.systemPrompt}\n\nYour workspace directory is: ${workspacePath}\nAlways use absolute paths (e.g. ${workspacePath}/skills/) when accessing files.`;
      const messages: Message[] = [
        { role: 'system', content: systemContent },
        ...prunedContext,
      ];
      response = await provider.chat(messages, allToolDefs, { model: state.model });
    } catch (llmError) {
      console.error(`[executor] LLM call error: ${llmError}`);
      executorState.status = 'repairing';
      try {
        await repair({
          workspacePath,
          error: llmError instanceof Error ? llmError : new Error(String(llmError)),
          provider: repairProvider,
          model: state.model ?? repairModel,
          userTools: repairTools,
          builtinToolDefs,
        });
        continue;
      } catch (repairError) {
        console.error(`[executor] repair failed: ${repairError}`);
        throw repairError;
      }
    }

    // Append assistant message
    currentContext.push({
      role: 'assistant',
      content: response.content,
      toolCalls: response.toolCalls ?? undefined,
    });

    if (response.content) {
      console.log(`[agent] ${response.content.slice(0, 120)}${response.content.length > 120 ? '...' : ''}`);
    }

    // Execute tool calls in parallel
    let shouldWait = false;

    if (response.toolCalls) {
      const results = await Promise.all(
        response.toolCalls.map((call) => executeToolCall(call, userTools, workspacePath))
      );

      for (const result of results) {
        currentContext.push(...result.messages);
        if (result.shouldWait) shouldWait = true;
      }
    }

    // Save to disk
    saveContext(workspacePath, currentContext);
    saveHistory(workspacePath, {
      round: state.round,
      timestamp: Date.now(),
      messages: currentContext,
      response,
      provider: state.provider,
      model: state.model,
    });

    // Re-read state from disk before saving, in case the agent modified it (e.g. changed model)
    const freshState = loadState(workspacePath);
    freshState.round = state.round + 1;
    saveState(workspacePath, freshState);

    // If agent produced no tool calls, nudge it to use tools
    if (!response.toolCalls) {
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
  }
}


