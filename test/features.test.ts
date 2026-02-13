import { describe, it, before, after } from 'node:test';
import { execSync } from 'node:child_process';
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

async function clearOutbox(baseUrl: string): Promise<void> {
  const { body: outbox } = await httpGet(baseUrl, '/outbox');
  for (const msg of outbox) {
    await httpDelete(baseUrl, `/outbox/${msg.id}`);
  }
}

describe('protocells feature tests', () => {
  before(async () => {
    buildImage();
    container = startContainer({
      mockProvider: true,
      provider: 'mock-features',
    });
    await waitForReady(container.baseUrl);
    await waitForReady(container.bridgeUrl);
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

  // ---- Test 1: Parallel tool execution ----

  it('parallel tool execution: all tools execute and produce results', async () => {
    await clearOutbox(container.baseUrl);
    const { body: status } = await httpGet(container.baseUrl, '/status');
    const startRound = status.round;

    await httpPost(container.baseUrl, '/message', {
      content: 'PARALLEL_TEST please',
      source: 'test-parallel:1',
    });

    await pollRound(container.baseUrl, startRound + 1, 15_000);

    // Reply was delivered to outbox
    const outbox = await pollOutbox(container.baseUrl, 1, 5_000);
    const reply = outbox.find((m: any) => m.source === 'test-parallel:1');
    assert.ok(reply, 'should have reply from parallel scenario');
    assert.ok(reply.content.includes('PARALLEL_C'), 'reply should contain PARALLEL_C');

    // write_file created marker
    const marker = dockerReadFile(container.id, '/workspace/parallel-marker.txt');
    assert.equal(marker.trim(), 'PARALLEL_B', 'marker file should contain PARALLEL_B');

    // Context has all tool results
    const ctx = JSON.parse(dockerReadFile(container.id, '/workspace/memory/context.json'));
    const assistantWithThree = ctx.find(
      (m: any) => m.role === 'assistant' && m.toolCalls?.length === 3
    );
    assert.ok(assistantWithThree, 'should have assistant message with 3 tool calls');
  });

  // ---- Test 2: Async bash (5s threshold) ----

  it('async bash: long command runs in background and notifies agent', async () => {
    await clearOutbox(container.baseUrl);
    const { body: status } = await httpGet(container.baseUrl, '/status');
    const startRound = status.round;

    await httpPost(container.baseUrl, '/message', {
      content: 'ASYNC_BASH_TEST please',
      source: 'test-async:1',
    });

    // Round 1 should complete quickly (bash went async after 5s)
    await pollRound(container.baseUrl, startRound + 1, 10_000);

    // Agent should be waiting
    const { body: s1 } = await httpGet(container.baseUrl, '/status');
    assert.equal(s1.status, 'waiting', 'agent should be waiting after async bash');

    // History should show "running in background" in tool result
    const roundNum = String(startRound).padStart(5, '0');
    const history = JSON.parse(
      dockerReadFile(container.id, `/workspace/history/round-${roundNum}.json`)
    );
    const toolResults = history.messages.filter((m: any) => m.role === 'tool');
    const asyncResult = toolResults.find((m: any) =>
      m.content?.includes('running in background')
    );
    assert.ok(asyncResult, 'tool result should contain "running in background"');

    // Async result should contain the output file path
    assert.ok(
      asyncResult.content.includes('/workspace/.tool-output/'),
      'async result should contain output file path'
    );

    // Extract output path and verify it's readable in real-time (command still running)
    const outputPathMatch = asyncResult.content.match(/output: (\/workspace\/\.tool-output\/[^\s)]+)/);
    assert.ok(outputPathMatch, 'async result should have parseable output path');
    const outputPath = outputPathMatch[1];
    const liveOutput = dockerReadFile(container.id, outputPath);
    assert.ok(typeof liveOutput === 'string', 'output file should be readable while command runs');

    // Wait for background job to complete — agent replies with ASYNC_COMPLETE
    // (bash async uses 2 rounds for the initial timeout + wait_for, then 1 more for system:bash notification)
    const outbox = await pollOutbox(container.baseUrl, 1, 15_000);
    const reply = outbox.find((m: any) => m.source === 'test-async:1');
    assert.ok(reply, 'should have reply after async bash completion');
    assert.ok(reply.content.includes('ASYNC_COMPLETE'), 'reply should contain ASYNC_COMPLETE');

    // After completion, output file should contain the final output + exit code
    const finalOutput = dockerReadFile(container.id, outputPath);
    assert.ok(finalOutput.includes('ASYNC_DONE'), 'output file should contain command output');
    assert.ok(finalOutput.includes('[exit code:'), 'output file should contain exit code');

    // Context should have system:bash message
    const ctx = JSON.parse(dockerReadFile(container.id, '/workspace/memory/context.json'));
    const systemBashMsg = ctx.find(
      (m: any) => m.role === 'user' && m.content?.includes('[system:bash]')
    );
    assert.ok(systemBashMsg, 'context should have system:bash notification');
  });

  // ---- Test 3: Reply routing ----

  it('reply routing: mock-im routes to bridge, other sources route to outbox', async () => {
    await clearOutbox(container.baseUrl);
    const { body: status } = await httpGet(container.baseUrl, '/status');
    const startRound = status.round;

    const testSessionId = 'route-test-session';

    await httpPost(container.baseUrl, '/message', {
      content: 'ROUTE_BRIDGE_TEST please',
      source: `mock-im:${testSessionId}`,
    });

    await pollRound(container.baseUrl, startRound + 1, 15_000);

    // Bridge should have the reply
    const { body: bridgeMessages } = await httpGet(
      container.bridgeUrl,
      `/messages?session=${testSessionId}`
    );
    const bridgeReply = bridgeMessages.find(
      (m: any) => m.role === 'assistant' && m.content?.includes('BRIDGE_ROUTED_REPLY')
    );
    assert.ok(bridgeReply, 'bridge should have BRIDGE_ROUTED_REPLY');

    // Outbox should have the other reply
    const outbox = await pollOutbox(container.baseUrl, 1, 5_000);
    const outboxReply = outbox.find((m: any) => m.source === 'test-outbox:1');
    assert.ok(outboxReply, 'outbox should have reply for test-outbox:1');
    assert.ok(outboxReply.content.includes('OUTBOX_ROUTED_REPLY'), 'should contain OUTBOX_ROUTED_REPLY');

    // routes.json should have mock-im entry
    const routes = JSON.parse(dockerReadFile(container.id, '/workspace/routes.json'));
    assert.ok(routes['mock-im'], 'routes.json should have mock-im entry');
    assert.ok(routes['mock-im'].url.includes('3001'), 'mock-im route should point to bridge port');
  });

  // ---- Test 4: bash_kill cancels background job ----

  it('bash_kill: agent cancels a long-running background command', async () => {
    await clearOutbox(container.baseUrl);
    const { body: status } = await httpGet(container.baseUrl, '/status');
    const startRound = status.round;

    await httpPost(container.baseUrl, '/message', {
      content: 'BASH_KILL_TEST please',
      source: 'test-kill:1',
    });

    // Wait for the kill + reply flow to complete
    const outbox = await pollOutbox(container.baseUrl, 1, 15_000);
    const reply = outbox.find((m: any) => m.source === 'test-kill:1');
    assert.ok(reply, 'should have reply after bash_kill');
    assert.ok(reply.content.startsWith('KILL_CONFIRMED:'), 'reply should confirm kill with job ID');

    // Extract job ID from reply
    const jobId = reply.content.split(':')[1];
    assert.ok(jobId && jobId.length === 8, 'job ID should be 8 chars');

    // Output file should exist (was being streamed)
    // Small delay to ensure the killed process's close event has settled
    await sleep(500);
    const outputPath = `/workspace/.tool-output/${jobId}.txt`;
    const output = dockerReadFile(container.id, outputPath);
    assert.ok(output.includes('KILL_STARTED'), `output file should have initial output, got: ${output.slice(0, 200)}`);
    assert.ok(!output.includes('SHOULD_NOT_APPEAR'), 'killed command should not have completed');

    // Context should have the bash_kill tool result
    const ctx = JSON.parse(dockerReadFile(container.id, '/workspace/memory/context.json'));
    const killResult = ctx.find(
      (m: any) => m.role === 'tool' && m.content?.includes('killed')
    );
    assert.ok(killResult, 'context should have bash_kill tool result');
  });

  // ---- Test 5: Streaming output is readable in real-time ----

  it('streaming: agent reads partial output from a running command', async () => {
    await clearOutbox(container.baseUrl);
    const { body: status } = await httpGet(container.baseUrl, '/status');
    const startRound = status.round;

    await httpPost(container.baseUrl, '/message', {
      content: 'STREAMING_TEST please',
      source: 'test-stream:1',
    });

    // Wait for the full flow: bash async → read_file → bash_kill + reply
    const outbox = await pollOutbox(container.baseUrl, 1, 20_000);
    const reply = outbox.find((m: any) => m.source === 'test-stream:1');
    assert.ok(reply, 'should have reply after streaming test');
    assert.ok(reply.content.startsWith('STREAM_CONTENT:'), 'reply should start with STREAM_CONTENT:');

    // The reply content should contain the streamed lines that the agent read mid-execution
    const streamedContent = reply.content.slice('STREAM_CONTENT:'.length);
    assert.ok(streamedContent.includes('STREAM_LINE_1'), 'streamed content should contain LINE_1');
    assert.ok(streamedContent.includes('STREAM_LINE_2'), 'streamed content should contain LINE_2');
    assert.ok(streamedContent.includes('STREAM_LINE_3'), 'streamed content should contain LINE_3');

    // Context should show the read_file call on the output file
    const ctx = JSON.parse(dockerReadFile(container.id, '/workspace/memory/context.json'));
    const readCall = ctx.find(
      (m: any) => m.role === 'assistant' && m.toolCalls?.some(
        (tc: any) => tc.name === 'read_file' && tc.args?.path?.includes('.tool-output')
      )
    );
    assert.ok(readCall, 'context should have read_file call on output file');

    // bash_kill should also appear
    const killCall = ctx.find(
      (m: any) => m.role === 'assistant' && m.toolCalls?.some(
        (tc: any) => tc.name === 'bash_kill'
      )
    );
    assert.ok(killCall, 'context should have bash_kill call to clean up');
  });

  // ---- Test 6: Agent self-modifies model (run last) ----

  it('agent self-modifies model: change persists across executor rounds', async () => {
    await clearOutbox(container.baseUrl);
    const { body: status } = await httpGet(container.baseUrl, '/status');
    const startRound = status.round;

    // Verify initial model is not the target
    const initialAgent = JSON.parse(dockerReadFile(container.id, '/workspace/agent.json'));
    assert.notEqual(initialAgent.model, 'test-model-switched', 'model should not be switched yet');

    await httpPost(container.baseUrl, '/message', {
      content: 'MODEL_SWITCH_TEST please',
      source: 'test-model:1',
    });

    // Wait for the full flow: read_file → write_file → reply → wait_for
    // This takes 2 executor rounds (read, then write+reply)
    await pollRound(container.baseUrl, startRound + 2, 15_000);

    // Verify reply was sent
    const outbox = await pollOutbox(container.baseUrl, 1, 5_000);
    const reply = outbox.find((m: any) => m.source === 'test-model:1');
    assert.ok(reply, 'should have MODEL_SWITCH_DONE reply');
    assert.ok(reply.content.includes('MODEL_SWITCH_DONE'), 'reply should confirm model switch');

    // agent.json should have the new model
    const agentJson = JSON.parse(dockerReadFile(container.id, '/workspace/agent.json'));
    assert.equal(agentJson.model, 'test-model-switched', 'model should be test-model-switched');

    // Round should have incremented normally
    assert.ok(agentJson.round >= startRound + 2, `round should be >= ${startRound + 2}`);

    // /status should reflect new model
    const { body: finalStatus } = await httpGet(container.baseUrl, '/status');
    assert.equal(finalStatus.model, 'test-model-switched', 'status should show new model');
  });

  // ---- Test 7: Spawn sub-agent ----

  it('spawn agent: parent spawns child, communicates, and kills it', async () => {
    await clearOutbox(container.baseUrl);
    const { body: status } = await httpGet(container.baseUrl, '/status');
    const startRound = status.round;

    await httpPost(container.baseUrl, '/message', {
      content: 'SPAWN_TEST please',
      source: 'test-spawn:1',
    });

    // Wait for full flow: clone → start child → health check → send message → child reply → kill + reply
    const outbox = await pollOutbox(container.baseUrl, 1, 30_000);
    const reply = outbox.find((m: any) => m.source === 'test-spawn:1');
    assert.ok(reply, 'should have reply after spawn test');
    assert.ok(reply.content.includes('SPAWN_COMPLETE'), 'reply should contain SPAWN_COMPLETE');

    // Child workspace should exist
    const childAgent = dockerReadFile(container.id, '/workspace-child/agent.json');
    assert.ok(childAgent, 'child workspace should have agent.json');

    // Parent routes should have child-1 entry
    const routes = JSON.parse(dockerReadFile(container.id, '/workspace/routes.json'));
    assert.ok(routes['child-1'], 'parent routes should have child-1 entry');

    // Child routes should have child-1 entry pointing to parent
    const childRoutes = JSON.parse(dockerReadFile(container.id, '/workspace-child/routes.json'));
    assert.ok(childRoutes['child-1'], 'child routes should have child-1 entry');

    // Context should have child-1: message from child reply
    const ctx = JSON.parse(dockerReadFile(container.id, '/workspace/memory/context.json'));
    const childMsg = ctx.find(
      (m: any) => m.role === 'user' && m.content?.includes('[child-1:')
    );
    assert.ok(childMsg, 'context should have child-1: message from child reply');
  });

  // ---- Test 8: Repair agent fixes broken provider ----

  it('repair agent: fixes broken provider script and resumes processing', async () => {
    await clearOutbox(container.baseUrl);
    const { body: status } = await httpGet(container.baseUrl, '/status');
    const startRound = status.round;

    // Corrupt the provider script with invalid JS
    execSync(
      `docker exec ${container.id} sh -c "echo '!!!BROKEN SYNTAX!!!' > /workspace/scripts/providers/mock-features.js"`,
      { timeout: 5_000 }
    );

    // Send a message — executor will fail to load the broken provider → enter repair mode
    await httpPost(container.baseUrl, '/message', {
      content: 'REPAIR_TEST please',
      source: 'test-repair:1',
    });

    // Wait for repair + processing (repair fixes the script, then executor resumes)
    await pollRound(container.baseUrl, startRound + 1, 20_000);

    // Verify reply was delivered (the fixed minimal provider echoes REPAIR_WORKED)
    const outbox = await pollOutbox(container.baseUrl, 1, 5_000);
    const reply = outbox.find((m: any) => m.source === 'test-repair:1');
    assert.ok(reply, 'should have reply after repair');
    assert.ok(reply.content.includes('REPAIR_WORKED'), 'reply should contain REPAIR_WORKED');

    // Verify container logs show repair was triggered
    const logs = dockerLogs(container.id);
    assert.ok(logs.includes('[repair]'), 'logs should contain [repair] entries');
    assert.ok(logs.includes('scripts fixed successfully'), 'logs should confirm repair success');

    // Verify repair context was persisted
    const repairCtx = JSON.parse(
      dockerReadFile(container.id, '/.repair/context.json')
    );
    assert.ok(Array.isArray(repairCtx), 'repair context should be an array');
    assert.ok(repairCtx.length > 0, 'repair context should have messages');
    const repairUserMsg = repairCtx.find(
      (m: any) => m.role === 'user' && m.content?.includes('[system:repair]')
    );
    assert.ok(repairUserMsg, 'repair context should contain system:repair message');

    // Verify repair history was saved
    const repairHistoryExists = dockerReadFile(
      container.id, '/.repair/history/repair-00000.json'
    );
    assert.ok(repairHistoryExists, 'repair history should be saved');
  });
});
