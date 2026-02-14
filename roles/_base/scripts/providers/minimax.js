import OpenAI from 'openai';
import crypto from 'node:crypto';

const client = new OpenAI({
  apiKey: process.env.MINIMAX_API_KEY,
  baseURL: 'https://api.minimax.io/v1',
});

// ---- Text-format parsing helpers ----
// MiniMax-M2.5-highspeed sometimes emits <think> and <tool_call> as plain text
// instead of using the function calling API. These helpers extract and convert them.

export function parseTextThink(content) {
  if (!content) return { thinking: null, cleanContent: content };
  const thinkRegex = /<think>([\s\S]*?)<\/think>/g;
  const thoughts = [];
  let match;
  while ((match = thinkRegex.exec(content)) !== null) {
    thoughts.push(match[1].trim());
  }
  const clean = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return {
    thinking: thoughts.length > 0 ? thoughts.join('\n') : null,
    cleanContent: clean || null,
  };
}

export function parseTextToolCalls(content) {
  if (!content) return null;
  const blockRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  const calls = [];
  let blockMatch;
  while ((blockMatch = blockRegex.exec(content)) !== null) {
    const block = blockMatch[1];
    // Support both <tool name="xxx"> and <invoke name="xxx">
    const nameMatch = block.match(/<(?:tool|invoke)\s+name="([^"]+)">/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    // Extract parameters
    const args = {};
    const paramRegex = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(block)) !== null) {
      args[paramMatch[1]] = paramMatch[2];
    }
    calls.push({
      id: `text-${name}-${crypto.randomUUID().slice(0, 8)}`,
      name,
      args,
    });
  }
  return calls.length > 0 ? calls : null;
}

export default {
  async chat(messages, tools, config) {
    const openaiTools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const openaiMessages = messages.map(m => {
      if (m.role === 'tool') {
        return { role: 'tool', content: m.content ?? '', tool_call_id: m.toolCallId };
      }
      if (m.role === 'assistant' && m.toolCalls) {
        return {
          role: 'assistant',
          content: m.content,
          tool_calls: m.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        };
      }
      return { role: m.role, content: m.content ?? '' };
    });

    const response = await client.chat.completions.create({
      model: config.model || 'MiniMax-M2.5',
      messages: openaiMessages,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
    });

    const choice = response.choices?.[0];
    if (!choice || !choice.message) {
      throw new Error(`MiniMax returned empty/invalid response: ${JSON.stringify(response).slice(0, 500)}`);
    }

    let toolCalls = choice.message.tool_calls?.map(tc => {
      let args;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch (e) {
        console.error(`[minimax] failed to parse tool args for ${tc.function.name}: ${tc.function.arguments?.slice(0, 200)}`);
        args = {};
      }
      return { id: tc.id, name: tc.function.name, args };
    });

    let content = choice.message.content;

    // Post-process: strip <think> tags from content
    const { thinking, cleanContent } = parseTextThink(content);
    if (thinking) {
      console.log(`[minimax] thinking: ${thinking.slice(0, 100)}${thinking.length > 100 ? '...' : ''}`);
    }
    content = cleanContent;

    // Post-process: parse text-format tool calls if API didn't return any
    if ((!toolCalls || toolCalls.length === 0) && content) {
      const textCalls = parseTextToolCalls(content);
      if (textCalls) {
        console.log(`[minimax] parsed ${textCalls.length} tool call(s) from text content: ${textCalls.map(tc => tc.name).join(', ')}`);
        toolCalls = textCalls;
        // Strip <tool_call> blocks from content
        content = content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim() || null;
      }
    }

    return {
      content,
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : null,
      usage: response.usage
        ? { input: response.usage.prompt_tokens, output: response.usage.completion_tokens }
        : undefined,
    };
  },
};
