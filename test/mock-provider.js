// Mock LLM provider for testing.
// Returns a reply tool call + wait_for.

let callCount = 0;

export default {
  async chat(messages, tools, config) {
    callCount++;

    // Find the last user message
    const userMessages = messages.filter(m => m.role === 'user' && typeof m.content === 'string');
    const lastUserMsg = userMessages[userMessages.length - 1];
    const userContent = lastUserMsg?.content ?? '(no message)';

    // Extract source from "[source] content" format
    const sourceMatch = userContent.match(/^\[([^\]]+)\]\s*(.*)/s);
    const source = sourceMatch ? sourceMatch[1] : 'unknown';
    const content = sourceMatch ? sourceMatch[2] : userContent;

    // Check if there are pending tool results - if so, this is a follow-up turn.
    // In that case just reply with wait_for.
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role === 'tool') {
      return {
        content: null,
        toolCalls: [
          { id: `wait-${callCount}`, name: 'wait_for', args: {} },
        ],
        usage: { input: 0, output: 0 },
      };
    }

    // First response: reply + wait_for
    return {
      content: null,
      toolCalls: [
        {
          id: `reply-${callCount}`,
          name: 'reply',
          args: {
            source,
            content: `Echo: ${content}`,
          },
        },
        {
          id: `wait-${callCount}`,
          name: 'wait_for',
          args: {},
        },
      ],
      usage: { input: 100, output: 50 },
    };
  },
};
