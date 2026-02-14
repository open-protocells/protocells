// === Messages ===

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

// === Queue ===

export interface QueueMessage {
  id: string;
  content: string;
  source: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// === Provider Script Contract ===

export interface ProviderScript {
  chat(
    messages: Message[],
    tools: ToolDef[],
    config: { model?: string }
  ): Promise<LLMResponse>;
}

export interface LLMResponse {
  content: string | null;
  toolCalls: ToolCall[] | null;
  usage?: { input: number; output: number };
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// === Tool Script Contract ===

export interface ToolScript {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: unknown): Promise<ToolResult>;
}

export interface ToolResult {
  result: string;
  action?: 'wait';
}

// === Agent State ===

export interface AgentState {
  provider: string;
  model?: string;
  round: number;
  maxRounds?: number;
  systemPrompt: string;
  role?: string;
}

// === Outbox ===

export interface OutboxMessage {
  id: string;
  source: string;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}
