import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  buildImage,
  startContainer,
  stopContainer,
  waitForReady,
  httpGet,
  httpPost,
  pollAdminReply,
  dockerReadFile,
  dockerLogs,
  type ContainerInfo,
} from './helpers.js';

// Support multiple providers: MiniMax (preferred), Anthropic, OpenAI
const MINIMAX_KEY = process.env.MINIMAX_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

let providerName: string;
let envVars: Record<string, string>;

if (MINIMAX_KEY) {
  providerName = 'minimax';
  envVars = { MINIMAX_API_KEY: MINIMAX_KEY };
} else if (ANTHROPIC_KEY) {
  providerName = 'anthropic';
  envVars = { ANTHROPIC_API_KEY: ANTHROPIC_KEY };
} else if (OPENAI_KEY) {
  providerName = 'openai';
  envVars = { OPENAI_API_KEY: OPENAI_KEY };
} else {
  console.log('No API key set. Set one of: MINIMAX_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY');
  console.log('Skipping live tests.');
  process.exit(0);
}

console.log(`[live test] using provider: ${providerName}`);

let container: ContainerInfo;
const sessionId = crypto.randomUUID();

describe(`protocells live tests (${providerName})`, () => {
  before(async () => {
    buildImage();
    container = startContainer({
      env: envVars,
      provider: providerName,
    });
    await waitForReady(container.baseUrl);
    // Also wait for bridge to be ready
    await waitForReady(container.adminUrl, 15_000, '/api/status');
  });

  after(() => {
    if (container) {
      try {
        console.log('\n--- Container Logs ---');
        console.log(dockerLogs(container.id));
        console.log('--- End Logs ---\n');
      } catch {}
      stopContainer(container);
    }
  });

  it('agent replies through admin dashboard', async () => {
    // Send message through bridge (like a real IM user would)
    const { status, body } = await httpPost(container.adminUrl, '/api/send', {
      session: sessionId,
      content: 'Say exactly: "Hello from protocells!" and nothing else.',
    });
    assert.equal(status, 200);
    assert.ok(body.ok);

    // Poll bridge for agent's reply (agent should read skill and use bash+curl)
    const reply = await pollAdminReply(container.adminUrl, sessionId, 120_000);
    assert.ok(reply.content, 'reply should have content');
    assert.ok(reply.content.length > 0, 'reply content should not be empty');
    console.log(`[live test] agent replied via bridge: ${reply.content.slice(0, 200)}`);
  });

  it('round was incremented', async () => {
    const { body } = await httpGet(container.baseUrl, '/status');
    assert.ok(body.round >= 1, `round should be >= 1, got ${body.round}`);
    assert.equal(body.provider, providerName);
  });

  it('history was written with real LLM response', async () => {
    const historyContent = dockerReadFile(container.id, '/workspace/history/round-00000.json');
    const history = JSON.parse(historyContent);
    assert.equal(history.round, 0);
    assert.equal(history.provider, providerName);
    assert.ok(history.response.usage, 'should have usage stats from real LLM');
    assert.ok(history.response.usage.input > 0, 'should have input tokens');
    assert.ok(history.response.usage.output > 0, 'should have output tokens');
  });

  it('bridge received the message flow', async () => {
    const { body: messages } = await httpGet(
      container.adminUrl,
      `/api/messages?session=${sessionId}`
    );
    assert.ok(Array.isArray(messages));
    assert.ok(messages.length >= 2, 'should have at least user + assistant messages');

    const userMsg = messages.find((m: any) => m.role === 'user');
    assert.ok(userMsg, 'should have user message');
    assert.ok(userMsg.content.includes('Hello from protocells'), 'user message preserved');

    const assistantMsg = messages.find((m: any) => m.role === 'assistant');
    assert.ok(assistantMsg, 'should have assistant message');
    assert.ok(assistantMsg.content.length > 0, 'assistant message has content');
  });
});
