import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildImage,
  startContainer,
  stopContainer,
  waitForReady,
  httpGet,
  httpPost,
  httpDelete,
  pollOutbox,
  pollRound,
  sleep,
  dockerReadFile,
  dockerLogs,
  type ContainerInfo,
} from './helpers.js';

let container: ContainerInfo;

describe('protocells mock tests', () => {
  before(async () => {
    buildImage();
    container = startContainer({ mockProvider: true });
    await waitForReady(container.baseUrl);
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

  it('GET /status returns initial state', async () => {
    const { status, body } = await httpGet(container.baseUrl, '/status');
    assert.equal(status, 200);
    assert.equal(body.status, 'waiting');
    assert.equal(body.round, 0);
  });

  it('POST /message returns messageId', async () => {
    const { status, body } = await httpPost(container.baseUrl, '/message', {
      content: 'hello agent',
      source: 'test:1',
    });
    assert.equal(status, 200);
    assert.ok(body.messageId, 'should return messageId');
    assert.equal(typeof body.messageId, 'string');
  });

  it('agent processes message and produces outbox reply', async () => {
    // The message from previous test should trigger the agent loop.
    // Mock provider returns reply + wait_for.
    // Wait for outbox to have a reply.
    const outbox = await pollOutbox(container.baseUrl, 1, 15_000);
    assert.ok(outbox.length >= 1, `expected at least 1 outbox message, got ${outbox.length}`);

    const reply = outbox[0];
    assert.equal(reply.source, 'test:1');
    assert.ok(reply.content.includes('Echo:'), `reply should echo: ${reply.content}`);
    assert.ok(reply.content.includes('hello agent'), `reply should contain original message: ${reply.content}`);
  });

  it('round incremented after processing', async () => {
    const { body } = await httpGet(container.baseUrl, '/status');
    assert.ok(body.round >= 1, `round should be >= 1, got ${body.round}`);
  });

  it('agent returns to waiting after processing', async () => {
    // Give it a moment to settle
    await sleep(1000);
    const { body } = await httpGet(container.baseUrl, '/status');
    assert.equal(body.status, 'waiting');
  });

  it('DELETE /outbox/:id consumes a reply', async () => {
    const { body: outbox } = await httpGet(container.baseUrl, '/outbox');
    assert.ok(outbox.length >= 1);

    const id = outbox[0].id;
    const { status } = await httpDelete(container.baseUrl, `/outbox/${id}`);
    assert.equal(status, 200);

    // Verify it's gone
    const { body: outbox2 } = await httpGet(container.baseUrl, '/outbox');
    const found = outbox2.find((m: any) => m.id === id);
    assert.equal(found, undefined, 'deleted message should be gone');
  });

  it('second message triggers another round', async () => {
    const currentStatus = await httpGet(container.baseUrl, '/status');
    const currentRound = currentStatus.body.round;

    await httpPost(container.baseUrl, '/message', {
      content: 'second message',
      source: 'test:2',
    });

    // Wait for round to increment
    await pollRound(container.baseUrl, currentRound + 1, 15_000);

    // Check outbox has new reply
    const outbox = await pollOutbox(container.baseUrl, 1, 5_000);
    const reply2 = outbox.find((m: any) => m.source === 'test:2');
    assert.ok(reply2, 'should have reply for test:2');
    assert.ok(reply2.content.includes('second message'));
  });

  it('history files are written', async () => {
    const historyContent = dockerReadFile(container.id, '/workspace/history/round-00000.json');
    const history = JSON.parse(historyContent);
    assert.equal(history.round, 0);
    assert.ok(Array.isArray(history.messages));
    assert.ok(history.timestamp > 0);
  });

  it('context is persisted', async () => {
    const contextContent = dockerReadFile(container.id, '/workspace/memory/context.json');
    const context = JSON.parse(contextContent);
    assert.ok(Array.isArray(context));
    assert.ok(context.length > 0, 'context should have messages');

    // Should contain user messages and assistant messages
    const roles = context.map((m: any) => m.role);
    assert.ok(roles.includes('user'), 'context should have user messages');
    assert.ok(roles.includes('assistant'), 'context should have assistant messages');
  });

  // ---- History endpoint tests ----

  it('GET /history returns paginated round list', async () => {
    const { status, body } = await httpGet(container.baseUrl, '/history');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.items), 'should return items array');
    assert.ok(body.total >= 2, `should have at least 2 rounds, got ${body.total}`);
    assert.equal(typeof body.offset, 'number');
    assert.equal(typeof body.limit, 'number');

    // Newest first
    if (body.items.length >= 2) {
      assert.ok(body.items[0].round > body.items[1].round, 'should be sorted newest-first');
    }

    const item = body.items[0];
    assert.equal(typeof item.round, 'number');
    assert.equal(typeof item.timestamp, 'number');
    assert.equal(typeof item.provider, 'string');
    assert.equal(typeof item.messageCount, 'number');
    assert.equal(typeof item.toolCallCount, 'number');
    assert.ok(Array.isArray(item.toolNames), 'should have toolNames array');
    assert.equal(typeof item.userPreview, 'string', 'should have userPreview string');
  });

  it('GET /history/:round returns full round detail', async () => {
    const { status, body } = await httpGet(container.baseUrl, '/history/0');
    assert.equal(status, 200);
    assert.equal(body.round, 0);
    assert.ok(Array.isArray(body.messages), 'should have messages array');
    assert.ok(body.response, 'should have response object');
    assert.equal(typeof body.timestamp, 'number');
    assert.equal(typeof body.provider, 'string');

    const roles = body.messages.map((m: any) => m.role);
    assert.ok(roles.includes('user'), 'should have user message');
    assert.ok(roles.includes('assistant'), 'should have assistant message');
  });

  it('GET /history/:round returns 404 for nonexistent round', async () => {
    const { status, body } = await httpGet(container.baseUrl, '/history/99999');
    assert.equal(status, 404);
    assert.ok(body.error);
  });

  it('GET /history supports pagination', async () => {
    const { status, body } = await httpGet(container.baseUrl, '/history?offset=0&limit=1');
    assert.equal(status, 200);
    assert.equal(body.items.length, 1, 'should return exactly 1 item');
    assert.equal(body.limit, 1);

    const { body: body2 } = await httpGet(container.baseUrl, '/history?offset=10000&limit=20');
    assert.equal(body2.items.length, 0, 'should return empty for offset beyond total');
  });

  it('POST /message rejects empty content', async () => {
    const { status } = await httpPost(container.baseUrl, '/message', {
      content: '',
    });
    assert.equal(status, 400);
  });

  it('GET /outbox on unknown DELETE returns 404', async () => {
    const { status } = await httpDelete(container.baseUrl, '/outbox/nonexistent-id');
    assert.equal(status, 404);
  });
});
