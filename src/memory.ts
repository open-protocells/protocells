import fs from 'node:fs';
import path from 'node:path';
import type { Message, ProviderScript, ToolDef } from './types.js';

// ============================================================
// Thresholds (in characters, ~4 chars per token)
// ============================================================

/** Start soft-trimming old tool results */
const PRUNE_SOFT_CHARS = 80_000;
/** Start hard-clearing old tool results */
const PRUNE_HARD_CHARS = 120_000;
/** Trigger full summarization compaction */
const COMPACT_CHARS = 160_000;
/** Number of recent assistant messages to protect from pruning */
const KEEP_LAST_ASSISTANTS = 3;
/** Soft-trim: keep first N + last N chars of large tool results */
const SOFT_TRIM_HEAD = 1500;
const SOFT_TRIM_TAIL = 1500;
/** Tool result considered "large" if over this many chars */
const SOFT_TRIM_THRESHOLD = 4000;
/** Placeholder for hard-cleared tool results */
const CLEARED_PLACEHOLDER = '[Tool result cleared to save context space]';

// ============================================================
// Load / Save
// ============================================================

export function loadContext(workspacePath: string): Message[] {
  const filePath = path.join(workspacePath, 'memory', 'context.json');
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as Message[];
}

export function saveContext(workspacePath: string, messages: Message[]): void {
  const dir = path.join(workspacePath, 'memory');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'context.json'), JSON.stringify(messages, null, 2));
}

// ============================================================
// Estimating context size
// ============================================================

function estimateMessageChars(msg: Message): number {
  let chars = msg.content?.length ?? 0;
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      try {
        chars += JSON.stringify(tc.args).length;
      } catch {
        chars += 128;
      }
      chars += (tc.name?.length ?? 0) + (tc.id?.length ?? 0);
    }
  }
  return chars;
}

function estimateContextChars(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageChars(m), 0);
}

// ============================================================
// Layer 1: Pruning (lightweight, in-memory only)
//
// Trims old tool results before sending to LLM.
// Does NOT modify the on-disk context.
// ============================================================

/**
 * Find the index of the Nth-from-last assistant message.
 * Tool results after this point are protected from pruning.
 */
function findPruneCutoff(messages: Message[], keepLast: number): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      count++;
      if (count >= keepLast) return i;
    }
  }
  return 0; // Not enough assistants, don't prune
}

function softTrimContent(content: string): string {
  if (content.length <= SOFT_TRIM_THRESHOLD) return content;
  const head = content.slice(0, SOFT_TRIM_HEAD);
  const tail = content.slice(-SOFT_TRIM_TAIL);
  return `${head}\n...\n[Trimmed: kept first ${SOFT_TRIM_HEAD} + last ${SOFT_TRIM_TAIL} of ${content.length} chars]\n...\n${tail}`;
}

export function pruneContext(messages: Message[]): Message[] {
  const totalChars = estimateContextChars(messages);
  if (totalChars < PRUNE_SOFT_CHARS) return messages;

  const cutoff = findPruneCutoff(messages, KEEP_LAST_ASSISTANTS);
  if (cutoff <= 0) return messages;

  const needsHardClear = totalChars >= PRUNE_HARD_CHARS;
  const result = messages.slice();
  let pruned = false;

  for (let i = 0; i < cutoff; i++) {
    const msg = result[i];
    if (msg.role !== 'tool' || !msg.content) continue;

    if (needsHardClear) {
      // Hard clear: replace entire content
      if (msg.content.length > 100) {
        result[i] = { ...msg, content: CLEARED_PLACEHOLDER };
        pruned = true;
      }
    } else {
      // Soft trim: keep head + tail
      const trimmed = softTrimContent(msg.content);
      if (trimmed !== msg.content) {
        result[i] = { ...msg, content: trimmed };
        pruned = true;
      }
    }
  }

  if (pruned) {
    const newChars = estimateContextChars(result);
    console.log(`[memory] pruned context: ${totalChars} → ${newChars} chars`);
  }

  return pruned ? result : messages;
}

// ============================================================
// Layer 2: Tool call / result repair
//
// After compaction splits messages, tool_use/tool_result pairs
// may be broken. This repairs them.
// ============================================================

export function repairToolPairing(messages: Message[]): Message[] {
  // Collect all tool call IDs from assistant messages
  const toolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        toolCallIds.add(tc.id);
      }
    }
  }

  // Collect all tool result IDs
  const toolResultIds = new Set<string>();
  const result: Message[] = [];

  for (const msg of messages) {
    if (msg.role === 'tool' && msg.toolCallId) {
      // Drop orphaned tool results (no matching assistant tool_call)
      if (!toolCallIds.has(msg.toolCallId)) {
        continue;
      }
      // Drop duplicates
      if (toolResultIds.has(msg.toolCallId)) {
        continue;
      }
      toolResultIds.add(msg.toolCallId);
    }
    result.push(msg);
  }

  // Add synthetic error results for assistant tool_calls without matching results
  const finalResult: Message[] = [];
  for (const msg of result) {
    finalResult.push(msg);
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (!toolResultIds.has(tc.id)) {
          finalResult.push({
            role: 'tool',
            content: '[Result cleared during context compaction]',
            toolCallId: tc.id,
          });
          toolResultIds.add(tc.id);
        }
      }
    }
  }

  return finalResult;
}

// ============================================================
// Layer 3: Compaction (persistent summarization)
//
// When pruning is not enough, summarize older messages.
// Uses chunked summarization for large contexts.
// ============================================================

export function shouldCompress(messages: Message[]): boolean {
  return estimateContextChars(messages) >= COMPACT_CHARS;
}

/**
 * Find a safe split point for compaction.
 * Must land on a user message to avoid breaking tool call pairs.
 * Aims to keep roughly the last 1/3 of messages.
 */
function findCompactionSplit(messages: Message[]): number {
  // Target: compress the first 2/3
  const targetKeep = Math.max(4, Math.floor(messages.length / 3));
  let splitIndex = messages.length - targetKeep;
  if (splitIndex < 1) splitIndex = 1;

  // Walk forward to find a user message (safe boundary)
  while (splitIndex < messages.length - 2 && messages[splitIndex].role !== 'user') {
    splitIndex++;
  }

  // If we couldn't find a user message, fall back to keeping last 6
  if (messages[splitIndex].role !== 'user') {
    splitIndex = Math.max(1, messages.length - 6);
    while (splitIndex < messages.length - 2 && messages[splitIndex].role !== 'user') {
      splitIndex++;
    }
  }

  return splitIndex;
}

/**
 * Serialize messages for summarization, truncating very long tool results.
 */
function serializeForSummary(messages: Message[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const content = m.content ?? '(tool call)';
    // Truncate very long content for the summarization prompt
    const truncated = content.length > 2000
      ? content.slice(0, 1000) + '\n...[truncated]...\n' + content.slice(-500)
      : content;
    if (m.role === 'tool') {
      parts.push(`[tool result] ${truncated}`);
    } else {
      parts.push(`[${m.role}] ${truncated}`);
    }
  }
  return parts.join('\n');
}

/**
 * Chunk messages for summarization to avoid sending too much to LLM at once.
 */
function chunkMessages(messages: Message[], maxChunkChars: number): Message[][] {
  const chunks: Message[][] = [];
  let current: Message[] = [];
  let currentChars = 0;

  for (const msg of messages) {
    const msgChars = estimateMessageChars(msg);
    if (current.length > 0 && currentChars + msgChars > maxChunkChars) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(msg);
    currentChars += msgChars;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

export async function compressContext(
  messages: Message[],
  provider: ProviderScript,
  _tools: ToolDef[],
  workspacePath: string
): Promise<Message[]> {
  const splitIndex = findCompactionSplit(messages);
  const toCompress = messages.slice(0, splitIndex);
  const toKeep = messages.slice(splitIndex);

  // Chunk the messages to compress (max ~30K chars per chunk for summarization)
  const chunks = chunkMessages(toCompress, 30_000);
  const partialSummaries: string[] = [];

  const summarySystemMsg = 'You are a context summarizer. Create a concise summary preserving: key decisions, task progress, important facts, file paths, user preferences, and open questions. Be specific about what was done and what remains. Output only the summary.';

  for (const chunk of chunks) {
    const serialized = serializeForSummary(chunk);
    try {
      const response = await provider.chat(
        [
          { role: 'system', content: summarySystemMsg },
          { role: 'user', content: serialized },
        ],
        [],
        {}
      );
      partialSummaries.push(response.content ?? 'No summary.');
    } catch (err) {
      console.error(`[memory] chunk summarization failed: ${err}`);
      // Fallback: just note that messages were dropped
      partialSummaries.push(`[${chunk.length} messages could not be summarized]`);
    }
  }

  // Concatenate chunk summaries (no merge LLM call — raw info is in round logs)
  const summary = partialSummaries.length === 1
    ? partialSummaries[0]
    : partialSummaries.map((s, i) => `### Part ${i + 1}\n${s}`).join('\n\n');

  // Append to summary.md
  const summaryPath = path.join(workspacePath, 'memory', 'summary.md');
  const existing = fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf-8') : '';
  fs.writeFileSync(summaryPath, existing + '\n\n---\n\n' + summary);

  console.log(`[memory] compacted ${toCompress.length} messages (${chunks.length} chunks) → summary`);

  // Repair tool pairing in kept messages
  const repairedKeep = repairToolPairing(toKeep);

  return [
    { role: 'user', content: `[Previous context summary]\n${summary}` },
    ...repairedKeep,
  ];
}
