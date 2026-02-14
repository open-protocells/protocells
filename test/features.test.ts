import { describe, it, before, after } from 'node:test';
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
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
  pollStatus,
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

  it('reply routing: admin routes to bridge, other sources route to outbox', async () => {
    await clearOutbox(container.baseUrl);
    const { body: status } = await httpGet(container.baseUrl, '/status');
    const startRound = status.round;

    const testSessionId = 'route-test-session';

    await httpPost(container.baseUrl, '/message', {
      content: 'ROUTE_BRIDGE_TEST please',
      source: `admin:${testSessionId}`,
    });

    await pollRound(container.baseUrl, startRound + 1, 15_000);

    // Bridge should have the reply
    const { body: bridgeMessages } = await httpGet(
      container.adminUrl,
      `/api/messages?session=${testSessionId}`
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

    // routes.json should have admin entry
    const routes = JSON.parse(dockerReadFile(container.id, '/workspace/routes.json'));
    assert.ok(routes['admin'], 'routes.json should have admin entry');
    assert.ok(routes['admin'].url.includes('3001'), 'admin route should point to bridge port');
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

  // ---- Test 8: Boot context guard ----

  it('boot context guard: worker clears inherited system:boot from context', async () => {
    const childPort = 3198;
    const wsPath = '/workspace-boot-test';

    // Create a workspace that simulates a bad clone (context.json has system:boot messages)
    execSync(
      `docker exec ${container.id} sh -c "` +
        `mkdir -p ${wsPath}/memory ${wsPath}/history ${wsPath}/outbox && ` +
        `cp -r /workspace/scripts ${wsPath}/ && ` +
        `cp -r /workspace/skills ${wsPath}/ && ` +
        `cp /workspace/agent.json ${wsPath}/ && ` +
        `echo '{}' > ${wsPath}/routes.json"`,
      { timeout: 5_000 }
    );

    // Write polluted context with system:boot message using node to avoid shell quoting issues
    execSync(
      `docker exec ${container.id} node -e "` +
        `require('fs').writeFileSync('${wsPath}/memory/context.json', JSON.stringify([` +
        `{role:'user',content:'[system:boot] System booted. You are the root agent.'},` +
        `{role:'assistant',content:null,toolCalls:[{id:'b1',name:'think',args:{thought:'spawn'}}]},` +
        `{role:'tool',content:'OK',toolCallId:'b1'}` +
        `]))"`,
      { timeout: 5_000 }
    );

    // Verify pre-condition: context has system:boot
    const beforeCtx = dockerReadFile(container.id, `${wsPath}/memory/context.json`);
    assert.ok(beforeCtx.includes('system:boot'), 'pre-condition: context should have system:boot');

    // Start agent WITHOUT SPAWN_WORKER (simulating a worker)
    execSync(
      `docker exec -d ${container.id} sh -c "PORT=${childPort} node /app/dist/agent.js ${wsPath}"`,
      { timeout: 5_000 }
    );

    // Wait for agent to start (context guard runs synchronously before server starts)
    const deadline = Date.now() + 10_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const res = execSync(
          `docker exec ${container.id} curl -sf http://localhost:${childPort}/status`,
          { encoding: 'utf-8', timeout: 2_000 }
        );
        if (res.includes('status')) { ready = true; break; }
      } catch { /* not ready yet */ }
      await sleep(500);
    }
    assert.ok(ready, 'boot-test agent should become ready');

    // context.json should be cleared (boot guard removed system:boot messages)
    const afterCtx = dockerReadFile(container.id, `${wsPath}/memory/context.json`);
    const parsed = JSON.parse(afterCtx);
    assert.deepEqual(parsed, [], 'context should be empty after boot guard cleared system:boot messages');

    // Clean up: kill the child agent
    execSync(
      `docker exec ${container.id} sh -c "ps aux | grep 'workspace-boot-test' | grep -v grep | awk '{print \\$2}' | xargs kill 2>/dev/null || true"`,
      { timeout: 5_000 }
    );
  });

  // ---- Test 9: Error state + external repair (was Test 8) ----

  it('error state: worker enters error state, external fix + repair-signal resumes', async () => {
    await clearOutbox(container.baseUrl);
    const { body: status } = await httpGet(container.baseUrl, '/status');
    const startRound = status.round;

    // Save the working provider to a temp path inside the container
    execSync(
      `docker exec ${container.id} cp /workspace/scripts/providers/mock-features.js /tmp/mock-features-backup.js`,
      { timeout: 5_000 }
    );

    // Corrupt the provider script with invalid JS
    execSync(
      `docker exec ${container.id} sh -c "echo '!!!BROKEN SYNTAX!!!' > /workspace/scripts/providers/mock-features.js"`,
      { timeout: 5_000 }
    );

    // Send a message — executor will fail to load the broken provider → enter error state
    await httpPost(container.baseUrl, '/message', {
      content: 'REPAIR_TEST please',
      source: 'test-repair:1',
    });

    // Poll /status until status === 'error'
    const errorStatus = await pollStatus(
      container.baseUrl,
      (s) => s.status === 'error',
      15_000
    );
    assert.equal(errorStatus.status, 'error', 'status should be error');
    assert.ok(errorStatus.error, 'error details should be present');
    assert.equal(errorStatus.error.source, 'script_load', 'error source should be script_load');

    // Restore the working provider from backup
    execSync(
      `docker exec ${container.id} cp /tmp/mock-features-backup.js /workspace/scripts/providers/mock-features.js`,
      { timeout: 5_000 }
    );

    // Signal the worker to resume
    await httpPost(container.baseUrl, '/repair-signal', {});

    // Wait for the executor to resume and process the queued message
    await pollRound(container.baseUrl, startRound + 1, 20_000);

    // Verify the agent recovered and processed the message
    const recoveredStatus = await pollStatus(
      container.baseUrl,
      (s) => s.status === 'waiting' || s.status === 'running',
      10_000
    );
    assert.notEqual(recoveredStatus.status, 'error', 'status should no longer be error');

    // Verify container logs show error state was entered
    const logs = dockerLogs(container.id);
    assert.ok(logs.includes('entering error state'), 'logs should show entering error state');
    assert.ok(logs.includes('repair signal detected'), 'logs should show repair signal detected');
  });

  // ---- Test 9: Admin status endpoint ----

  it('admin status: GET /api/status returns admin info', async () => {
    const { status, body } = await httpGet(container.adminUrl, '/api/status');
    assert.equal(status, 200);
    assert.equal(body.admin, true, 'should identify as admin');
    assert.equal(body.port, 3001, 'should report port 3001');
    assert.equal(body.agentPort, 3000, 'should report agent port 3000');
  });

  // ---- Test 10: Admin agents discovery ----

  it('admin agents: GET /api/agents returns discovered agents', async () => {
    const { status, body } = await httpGet(container.adminUrl, '/api/agents');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body), 'should return array');
    assert.ok(body.length >= 1, 'should have at least the root agent');

    const root = body.find((a: any) => a.name === 'root');
    assert.ok(root, 'should have root agent');
    assert.equal(root.online, true, 'root agent should be online');
    assert.ok(root.status, 'root agent should have status');
  });

  // ---- Test 11: Admin system-info endpoint ----

  it('admin system-info: GET /api/system-info returns monitoring data', async () => {
    const { status, body } = await httpGet(container.adminUrl, '/api/system-info');
    assert.equal(status, 200);
    assert.ok(body.memory, 'should have memory info');
    assert.ok(body.memory.system.total > 0, 'should have system total memory');
    assert.ok(body.memory.process.rss > 0, 'should have process RSS');
    assert.ok(body.uptime, 'should have uptime info');
    assert.ok(body.uptime.process > 0, 'should have process uptime');
    assert.ok(body.platform, 'should have platform info');
  });

  // ---- Admin history proxy tests ----

  it('admin history proxy: GET /api/history returns agent history', async () => {
    const { status, body } = await httpGet(container.adminUrl, '/api/history?agent=root');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.items), 'should return items array');
    assert.ok(body.total >= 1, `should have at least 1 round, got ${body.total}`);
  });

  it('admin history proxy: GET /api/history/:round returns detail', async () => {
    const { status, body } = await httpGet(container.adminUrl, '/api/history/0?agent=root');
    assert.equal(status, 200);
    assert.equal(body.round, 0);
    assert.ok(Array.isArray(body.messages), 'should have messages');
  });

  it('admin history proxy: unknown agent returns 404', async () => {
    const { status, body } = await httpGet(container.adminUrl, '/api/history?agent=nonexistent');
    assert.equal(status, 404);
    assert.ok(body.error);
  });

  // ---- Admin chat sends to agent and receives reply ----

  it('admin chat: POST /api/send forwards to agent and reply arrives', async () => {
    const sessionId = 'admin-chat-test-' + Date.now();

    // Send via admin
    const { status } = await httpPost(container.adminUrl, '/api/send', {
      session: sessionId,
      content: 'Hello from admin chat',
    });
    assert.equal(status, 200);

    // Poll admin messages for the agent's reply
    const deadline = Date.now() + 30_000;
    let replyFound = false;
    while (Date.now() < deadline) {
      const { body: messages } = await httpGet(
        container.adminUrl,
        `/api/messages?session=${sessionId}`
      );
      const reply = messages.find((m: any) => m.role === 'assistant');
      if (reply) {
        replyFound = true;
        assert.ok(reply.content.length > 0, 'reply should have content');
        break;
      }
      await sleep(1000);
    }
    assert.ok(replyFound, 'should receive agent reply through admin chat');
  });

  // ---- Role Template Tests ----

  it('role template: worker workspace has correct skills and config', async () => {
    // The container was started without SPAWN_WORKER, so it initialized as a worker
    const agentJson = JSON.parse(dockerReadFile(container.id, '/workspace/agent.json'));
    assert.equal(agentJson.role, 'worker', 'agent.json should have role: worker');

    // prompt.md should have worker content
    const promptMd = dockerReadFile(container.id, '/workspace/prompt.md');
    assert.ok(promptMd.includes('Worker Agent'), 'prompt.md should contain Worker Agent');
    assert.ok(!promptMd.includes('Root Coordinator'), 'prompt.md should NOT contain Root Coordinator');

    // Worker skills should exist
    const skillsList = execSync(`docker exec ${container.id} ls /workspace/skills/`, { encoding: 'utf-8' });
    assert.ok(skillsList.includes('slack'), 'worker should have slack skill');
    assert.ok(skillsList.includes('admin'), 'worker should have admin skill');

    // Root-only skills should NOT exist
    assert.ok(!skillsList.includes('spawn-agent'), 'worker should NOT have spawn-agent skill');
    assert.ok(!skillsList.includes('self-update'), 'worker should NOT have self-update skill');

    // Base shared tools should exist
    const toolsList = execSync(`docker exec ${container.id} ls /workspace/scripts/tools/`, { encoding: 'utf-8' });
    assert.ok(toolsList.includes('bash.js'), 'should have bash tool');
    assert.ok(toolsList.includes('read-file.js'), 'should have read-file tool');
    assert.ok(toolsList.includes('write-file.js'), 'should have write-file tool');
  });

  it('role template: root workspace has correct skills and config', async () => {
    const rootWs = '/workspace-root-template-test';
    const rootPort = 3197;

    // Start a root agent (SPAWN_WORKER=true)
    execSync(
      `docker exec -d -e SPAWN_WORKER=true ${container.id} sh -c "PORT=${rootPort} node /app/dist/agent.js ${rootWs}"`,
      { timeout: 5_000 }
    );

    // Wait for agent to start
    const deadline = Date.now() + 10_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const res = execSync(
          `docker exec ${container.id} curl -sf http://localhost:${rootPort}/status`,
          { encoding: 'utf-8', timeout: 2_000 }
        );
        if (res.includes('status')) { ready = true; break; }
      } catch { /* not ready yet */ }
      await sleep(500);
    }
    assert.ok(ready, 'root agent should become ready');

    // Check agent.json
    const agentJson = JSON.parse(dockerReadFile(container.id, `${rootWs}/agent.json`));
    assert.equal(agentJson.role, 'root', 'agent.json should have role: root');

    // Check prompt.md
    const promptMd = dockerReadFile(container.id, `${rootWs}/prompt.md`);
    assert.ok(promptMd.includes('Root Coordinator'), 'prompt.md should contain Root Coordinator');
    assert.ok(!promptMd.includes('Worker Agent'), 'prompt.md should NOT contain Worker Agent');

    // Root skills should exist
    const skillsList = execSync(`docker exec ${container.id} ls ${rootWs}/skills/`, { encoding: 'utf-8' });
    assert.ok(skillsList.includes('spawn-agent'), 'root should have spawn-agent skill');
    assert.ok(skillsList.includes('self-update'), 'root should have self-update skill');

    // Worker-only skills should NOT exist
    assert.ok(!skillsList.includes('slack'), 'root should NOT have slack skill');
    assert.ok(!skillsList.includes('admin'), 'root should NOT have admin skill');

    // Clean up: kill the root agent process
    execSync(
      `docker exec ${container.id} sh -c "ps aux | grep 'workspace-root-template-test' | grep -v grep | awk '{print \\$2}' | xargs kill 2>/dev/null || true"`,
      { timeout: 5_000 }
    );
  });

  it('role template: inherited root state resets to worker role with correct skills', async () => {
    const ws = '/workspace-role-reset-test';
    const testPort = 3196;

    // Create a workspace that simulates a clone from root agent
    execSync(
      `docker exec ${container.id} sh -c "` +
        `mkdir -p ${ws}/memory ${ws}/history ${ws}/outbox ${ws}/skills && ` +
        `cp -r /workspace/scripts ${ws}/ && ` +
        `echo '{}' > ${ws}/routes.json && ` +
        `echo '[]' > ${ws}/memory/context.json"`,
      { timeout: 5_000 }
    );

    // Write agent.json with role: root and round > 0 (simulating cloned root state)
    execSync(
      `docker exec ${container.id} node -e "` +
        `const fs = require('fs'); ` +
        `const state = JSON.parse(fs.readFileSync('/workspace/agent.json', 'utf-8')); ` +
        `state.role = 'root'; ` +
        `state.round = 5; ` +
        `fs.writeFileSync('${ws}/agent.json', JSON.stringify(state, null, 2))"`,
      { timeout: 5_000 }
    );

    // Copy root skills and prompt (simulating cloned root workspace)
    execSync(
      `docker exec ${container.id} sh -c "` +
        `cp -r /app/roles/root/skills/* ${ws}/skills/ && ` +
        `cp /app/roles/root/prompt.md ${ws}/prompt.md"`,
      { timeout: 5_000 }
    );

    // Verify pre-conditions
    const beforeAgent = JSON.parse(dockerReadFile(container.id, `${ws}/agent.json`));
    assert.equal(beforeAgent.role, 'root', 'pre-condition: should have root role');
    const beforeSkills = execSync(`docker exec ${container.id} ls ${ws}/skills/`, { encoding: 'utf-8' });
    assert.ok(beforeSkills.includes('spawn-agent'), 'pre-condition: should have spawn-agent skill');

    // Start agent WITHOUT SPAWN_WORKER (worker that inherited root state)
    execSync(
      `docker exec -d ${container.id} sh -c "PORT=${testPort} node /app/dist/agent.js ${ws}"`,
      { timeout: 5_000 }
    );

    // Wait for agent to start (boot guard runs synchronously before server)
    const deadline = Date.now() + 10_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const res = execSync(
          `docker exec ${container.id} curl -sf http://localhost:${testPort}/status`,
          { encoding: 'utf-8', timeout: 2_000 }
        );
        if (res.includes('status')) { ready = true; break; }
      } catch { /* not ready yet */ }
      await sleep(500);
    }
    assert.ok(ready, 'agent should become ready after role reset');

    // agent.json should be reset to worker
    const afterAgent = JSON.parse(dockerReadFile(container.id, `${ws}/agent.json`));
    assert.equal(afterAgent.role, 'worker', 'agent.json role should be reset to worker');
    assert.equal(afterAgent.round, 0, 'round should be reset to 0');

    // prompt.md should be overwritten with worker content
    const promptMd = dockerReadFile(container.id, `${ws}/prompt.md`);
    assert.ok(promptMd.includes('Worker Agent'), 'prompt.md should have worker content after reset');
    assert.ok(!promptMd.includes('Root Coordinator'), 'prompt.md should NOT have root content after reset');

    // Skills should be replaced with worker skills
    const afterSkills = execSync(`docker exec ${container.id} ls ${ws}/skills/`, { encoding: 'utf-8' });
    assert.ok(afterSkills.includes('slack'), 'should have slack skill after reset');
    assert.ok(afterSkills.includes('admin'), 'should have admin skill after reset');
    assert.ok(!afterSkills.includes('spawn-agent'), 'should NOT have spawn-agent skill after reset');
    assert.ok(!afterSkills.includes('self-update'), 'should NOT have self-update skill after reset');

    // Context should be cleared
    const ctx = JSON.parse(dockerReadFile(container.id, `${ws}/memory/context.json`));
    assert.deepEqual(ctx, [], 'context should be empty after role reset');

    // Clean up
    execSync(
      `docker exec ${container.id} sh -c "ps aux | grep 'workspace-role-reset-test' | grep -v grep | awk '{print \\$2}' | xargs kill 2>/dev/null || true"`,
      { timeout: 5_000 }
    );
  });

  it('role template: system prompt includes role-specific content from prompt.md', async () => {
    await clearOutbox(container.baseUrl);
    const { body: status } = await httpGet(container.baseUrl, '/status');
    const startRound = status.round;

    await httpPost(container.baseUrl, '/message', {
      content: 'ROLE_PROMPT_TEST please',
      source: 'test-role-prompt:1',
    });

    await pollRound(container.baseUrl, startRound + 1, 15_000);

    const outbox = await pollOutbox(container.baseUrl, 1, 5_000);
    const reply = outbox.find((m: any) => m.source === 'test-role-prompt:1');
    assert.ok(reply, 'should have reply from role prompt test');
    assert.ok(
      reply.content.includes('worker=true'),
      `system prompt should include Worker Agent content from prompt.md, got: ${reply.content}`
    );
    assert.ok(
      reply.content.includes('workspace=true'),
      `system prompt should include workspace path, got: ${reply.content}`
    );
  });
});
