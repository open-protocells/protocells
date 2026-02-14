import OpenAI from 'openai';

const client = new OpenAI();

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
      model: config.model || 'gpt-4o',
      messages: openaiMessages,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
    });

    const choice = response.choices?.[0];
    if (!choice || !choice.message) {
      throw new Error(`OpenAI returned empty/invalid response: ${JSON.stringify(response).slice(0, 500)}`);
    }

    const toolCalls = choice.message.tool_calls?.map(tc => {
      let args;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch (e) {
        console.error(`[openai] failed to parse tool args for ${tc.function.name}: ${tc.function.arguments?.slice(0, 200)}`);
        args = {};
      }
      return { id: tc.id, name: tc.function.name, args };
    });

    return {
      content: choice.message.content,
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : null,
      usage: response.usage
        ? { input: response.usage.prompt_tokens, output: response.usage.completion_tokens }
        : undefined,
    };
  },
};
