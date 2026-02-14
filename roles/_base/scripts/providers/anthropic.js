import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

export default {
  async chat(messages, tools, config) {
    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystemMsgs = messages.filter(m => m.role !== 'system');

    const anthropicTools = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));

    const anthropicMessages = nonSystemMsgs.map(m => {
      if (m.role === 'tool') {
        return {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
        };
      }
      if (m.role === 'assistant' && m.toolCalls) {
        return {
          role: 'assistant',
          content: [
            ...(m.content ? [{ type: 'text', text: m.content }] : []),
            ...m.toolCalls.map(tc => ({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.args,
            })),
          ],
        };
      }
      return { role: m.role, content: m.content ?? '' };
    });

    const response = await client.messages.create({
      model: config.model || 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemMsg?.content ?? '',
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      messages: anthropicMessages,
    });

    let content = null;
    const toolCalls = [];

    for (const block of response.content) {
      if (block.type === 'text') content = block.text;
      if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, args: block.input });
      }
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
    };
  },
};
