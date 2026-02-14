import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTextThink, parseTextToolCalls } from '../roles/_base/scripts/providers/minimax.js';

describe('parseTextThink', () => {
  it('returns null thinking for null/empty content', () => {
    assert.deepEqual(parseTextThink(null), { thinking: null, cleanContent: null });
    assert.deepEqual(parseTextThink(''), { thinking: null, cleanContent: '' });
  });

  it('returns content unchanged when no think tags', () => {
    const result = parseTextThink('Hello world');
    assert.equal(result.thinking, null);
    assert.equal(result.cleanContent, 'Hello world');
  });

  it('extracts single think block', () => {
    const result = parseTextThink('<think>Planning my response</think>');
    assert.equal(result.thinking, 'Planning my response');
    assert.equal(result.cleanContent, null); // only think content, nothing left
  });

  it('extracts think block and preserves remaining content', () => {
    const result = parseTextThink('<think>Let me think about this</think>\n\nHere is my answer.');
    assert.equal(result.thinking, 'Let me think about this');
    assert.equal(result.cleanContent, 'Here is my answer.');
  });

  it('handles multiple think blocks', () => {
    const input = '<think>First thought</think>\nSome text\n<think>Second thought</think>';
    const result = parseTextThink(input);
    assert.equal(result.thinking, 'First thought\nSecond thought');
    assert.equal(result.cleanContent, 'Some text');
  });

  it('handles multiline think content', () => {
    const input = '<think>\nLine 1\nLine 2\nLine 3\n</think>\nAnswer here';
    const result = parseTextThink(input);
    assert.equal(result.thinking, 'Line 1\nLine 2\nLine 3');
    assert.equal(result.cleanContent, 'Answer here');
  });
});

describe('parseTextToolCalls', () => {
  it('returns null for null/empty content', () => {
    assert.equal(parseTextToolCalls(null), null);
    assert.equal(parseTextToolCalls(''), null);
  });

  it('returns null when no tool_call tags', () => {
    assert.equal(parseTextToolCalls('Just some text'), null);
  });

  it('parses <tool name> format', () => {
    const input = `<tool_call>
<tool name="bash">
<parameter name="command">echo hello</parameter>
</tool>
</tool_call>`;
    const result = parseTextToolCalls(input);
    assert.ok(result);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'bash');
    assert.deepEqual(result[0].args, { command: 'echo hello' });
    assert.ok(result[0].id.startsWith('text-bash-'));
  });

  it('parses <invoke name> format', () => {
    const input = `<tool_call>
<invoke name="reply">
<parameter name="source">slack:C01234567</parameter>
<parameter name="content">Hello!</parameter>
</invoke>
</tool_call>`;
    const result = parseTextToolCalls(input);
    assert.ok(result);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'reply');
    assert.deepEqual(result[0].args, { source: 'slack:C01234567', content: 'Hello!' });
  });

  it('parses tool with no parameters (wait_for)', () => {
    const input = `<tool_call>
<tool name="wait_for">
</tool>
</tool_call>`;
    const result = parseTextToolCalls(input);
    assert.ok(result);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'wait_for');
    assert.deepEqual(result[0].args, {});
  });

  it('parses multiple tool_call blocks', () => {
    const input = `<tool_call>
<tool name="bash">
<parameter name="command">ls -la</parameter>
</tool>
</tool_call>
<tool_call>
<invoke name="reply">
<parameter name="source">slack:C01</parameter>
<parameter name="content">Done</parameter>
</invoke>
</tool_call>`;
    const result = parseTextToolCalls(input);
    assert.ok(result);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, 'bash');
    assert.equal(result[1].name, 'reply');
    assert.deepEqual(result[1].args, { source: 'slack:C01', content: 'Done' });
  });

  it('handles multiline parameter values', () => {
    const input = `<tool_call>
<invoke name="reply">
<parameter name="source">slack:C01</parameter>
<parameter name="content">Line 1
Line 2
Line 3</parameter>
</invoke>
</tool_call>`;
    const result = parseTextToolCalls(input);
    assert.ok(result);
    assert.equal(result[0].name, 'reply');
    assert.equal(result[0].args.content, 'Line 1\nLine 2\nLine 3');
  });

  it('skips malformed tool_call blocks (no name)', () => {
    const input = `<tool_call>
<something>no name attr</something>
</tool_call>`;
    const result = parseTextToolCalls(input);
    assert.equal(result, null);
  });

  it('works with mixed think + tool_call content', () => {
    const input = `<think>Let me think about this</think>

<tool_call>
<invoke name="bash">
<parameter name="command">curl -s http://example.com</parameter>
</invoke>
</tool_call>`;
    const result = parseTextToolCalls(input);
    assert.ok(result);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'bash');
    assert.equal(result[0].args.command, 'curl -s http://example.com');
  });

  it('handles real-world MiniMax output with [tool] marker', () => {
    const input = `<think>
用户发送了新消息。让我读取。
</think>


[tool]

<tool_call>
<invoke name="bash">
<parameter name="command">curl -s "https://slack.com/api/conversations.history?channel=C0AEUQJ8T6X&limit=1" -H "Authorization: Bearer $SLACK_BOT_TOKEN" 2>/dev/null</parameter>
</invoke>
</tool_call>`;
    const result = parseTextToolCalls(input);
    assert.ok(result);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'bash');
    assert.ok(result[0].args.command.includes('conversations.history'));
  });
});

describe('parseTextThink + parseTextToolCalls integration', () => {
  it('full pipeline: strip think, then parse tool calls from cleaned content', () => {
    const raw = `<think>
The user wants me to reply.
</think>


[tool]

<tool_call>
<tool name="reply">
<parameter name="content">收到你的消息了，有事请说~</parameter>
<parameter name="source">slack:C0AEUQJ8T6X</parameter>
</tool>
</tool_call>`;

    // Step 1: strip think
    const { thinking, cleanContent } = parseTextThink(raw);
    assert.equal(thinking, 'The user wants me to reply.');
    assert.ok(cleanContent);

    // Step 2: parse tool calls from cleaned content
    const toolCalls = parseTextToolCalls(cleanContent);
    assert.ok(toolCalls);
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].name, 'reply');
    assert.equal(toolCalls[0].args.source, 'slack:C0AEUQJ8T6X');
    assert.equal(toolCalls[0].args.content, '收到你的消息了，有事请说~');

    // Step 3: strip tool_call blocks from content
    const finalContent = cleanContent.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim() || null;
    // Only [tool] marker remains, which is just noise
    assert.ok(!finalContent || !finalContent.includes('<tool_call>'));
  });
});
