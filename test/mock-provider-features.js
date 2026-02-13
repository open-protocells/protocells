// Multi-scenario mock provider for feature tests.
// Dispatches based on keywords in user messages.

let callCount = 0;

function extractSource(content) {
  const m = content.match(/^\[([^\]]+)\]\s*(.*)/s);
  return m ? { source: m[1], text: m[2] } : { source: 'unknown', text: content };
}

function findUserMessage(messages, keyword) {
  return messages.find(
    (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes(keyword)
  );
}

function sourceOf(msg) {
  return msg?.content?.match(/^\[([^\]]+)\]/)?.[1] || 'unknown';
}

// ---- Scenarios ----

function parallelScenario(source) {
  return {
    content: null,
    toolCalls: [
      { id: `par-bash-${callCount}`, name: 'bash', args: { command: 'echo PARALLEL_A' } },
      { id: `par-write-${callCount}`, name: 'write_file', args: { path: '/workspace/parallel-marker.txt', content: 'PARALLEL_B' } },
      { id: `par-reply-${callCount}`, name: 'reply', args: { source, content: 'PARALLEL_C' } },
    ],
    usage: { input: 10, output: 10 },
  };
}

function asyncBashScenario() {
  return {
    content: null,
    toolCalls: [
      { id: `async-bash-${callCount}`, name: 'bash', args: { command: 'sleep 7 && echo ASYNC_DONE' } },
    ],
    usage: { input: 10, output: 10 },
  };
}

function systemBashScenario(messages) {
  // Find the original user source that triggered ASYNC_BASH_TEST
  const orig = findUserMessage(messages, 'ASYNC_BASH_TEST');
  const origSource = sourceOf(orig);
  return {
    content: null,
    toolCalls: [
      { id: `bash-done-reply-${callCount}`, name: 'reply', args: { source: origSource, content: 'ASYNC_COMPLETE' } },
      { id: `bash-done-wait-${callCount}`, name: 'wait_for', args: {} },
    ],
    usage: { input: 10, output: 10 },
  };
}

function routeBridgeScenario(source) {
  return {
    content: null,
    toolCalls: [
      { id: `route-bridge-${callCount}`, name: 'reply', args: { source, content: 'BRIDGE_ROUTED_REPLY' } },
      { id: `route-outbox-${callCount}`, name: 'reply', args: { source: 'test-outbox:1', content: 'OUTBOX_ROUTED_REPLY' } },
    ],
    usage: { input: 10, output: 10 },
  };
}

function modelSwitchScenario() {
  // Step 1: read agent.json
  return {
    content: null,
    toolCalls: [
      { id: `model-read-${callCount}`, name: 'read_file', args: { path: '/workspace/agent.json' } },
    ],
    usage: { input: 10, output: 10 },
  };
}

function modelSwitchFollowUp(messages, source) {
  // Find the read_file tool result containing agent.json content
  const toolResults = messages.filter((m) => m.role === 'tool');
  let agentJson = null;
  for (const tr of toolResults) {
    try {
      const parsed = JSON.parse(tr.content);
      if (parsed.provider && parsed.systemPrompt !== undefined) {
        agentJson = parsed;
        break;
      }
    } catch {}
    // read_file returns "[Lines ...]\n..." format, try stripping header
    const lines = tr.content?.split('\n');
    if (lines && lines[0]?.startsWith('[Lines')) {
      try {
        const jsonStr = lines.slice(1).join('\n');
        const parsed = JSON.parse(jsonStr);
        if (parsed.provider) {
          agentJson = parsed;
          break;
        }
      } catch {}
    }
  }

  if (!agentJson) {
    // Fallback: just write a minimal agent.json
    agentJson = { provider: 'mock-features', model: 'test-model-switched', round: 0, maxRounds: 1000, systemPrompt: '' };
  } else {
    agentJson.model = 'test-model-switched';
  }

  return {
    content: null,
    toolCalls: [
      { id: `model-write-${callCount}`, name: 'write_file', args: { path: '/workspace/agent.json', content: JSON.stringify(agentJson, null, 2) } },
      { id: `model-reply-${callCount}`, name: 'reply', args: { source, content: 'MODEL_SWITCH_DONE' } },
      { id: `model-wait-${callCount}`, name: 'wait_for', args: {} },
    ],
    usage: { input: 10, output: 10 },
  };
}

// ---- Bash kill scenario ----

function bashKillScenario() {
  return {
    content: null,
    toolCalls: [
      { id: `kill-bash-${callCount}`, name: 'bash', args: { command: 'echo KILL_STARTED && sleep 100 && echo SHOULD_NOT_APPEAR' } },
    ],
    usage: { input: 10, output: 10 },
  };
}

function bashKillFollowUp(messages, source) {
  // Extract job ID from the bash tool result for the KILL_STARTED command
  const toolResults = messages.filter((m) => m.role === 'tool');
  const asyncResult = toolResults.find((m) =>
    m.content?.includes('running in background') && m.content?.includes('KILL_STARTED')
  );
  const jobIdMatch = asyncResult?.content?.match(/job: ([a-f0-9]+)/);
  const jobId = jobIdMatch?.[1] || 'unknown';

  return {
    content: null,
    toolCalls: [
      { id: `kill-cmd-${callCount}`, name: 'bash_kill', args: { id: jobId } },
      { id: `kill-reply-${callCount}`, name: 'reply', args: { source, content: 'KILL_CONFIRMED:' + jobId } },
      { id: `kill-wait-${callCount}`, name: 'wait_for', args: {} },
    ],
    usage: { input: 10, output: 10 },
  };
}

// ---- Streaming scenario ----

function streamingScenario() {
  return {
    content: null,
    toolCalls: [
      { id: `stream-bash-${callCount}`, name: 'bash', args: { command: 'echo STREAM_LINE_1 && sleep 1 && echo STREAM_LINE_2 && sleep 1 && echo STREAM_LINE_3 && sleep 100' } },
    ],
    usage: { input: 10, output: 10 },
  };
}

function streamingFollowUp(messages, source) {
  // Extract output path from the STREAMING bash tool result (contains STREAM_LINE)
  const toolResults = messages.filter((m) => m.role === 'tool');
  const asyncResult = toolResults.find((m) =>
    m.content?.includes('running in background') && m.content?.includes('STREAM_LINE')
  );
  const pathMatch = asyncResult?.content?.match(/output: (\/workspace\/\.tool-output\/[^\s)]+)/);
  const outputPath = pathMatch?.[1] || '/workspace/.tool-output/unknown.txt';
  const jobIdMatch = asyncResult?.content?.match(/job: ([a-f0-9]+)/);
  const jobId = jobIdMatch?.[1] || 'unknown';

  // Check if we already did the read_file for this streaming output
  const alreadyRead = messages.some(
    (m) => m.role === 'assistant' && m.toolCalls?.some(
      (tc) => tc.name === 'read_file' && tc.args?.path === outputPath
    )
  );

  if (!alreadyRead) {
    // Step 1: read the streaming output file
    return {
      content: null,
      toolCalls: [
        { id: `stream-read-${callCount}`, name: 'read_file', args: { path: outputPath } },
      ],
      usage: { input: 10, output: 10 },
    };
  }

  // Step 2: got the file content — find the read_file result for this specific file
  const readResult = toolResults.find((m) =>
    m.content?.includes('STREAM_LINE')
  );
  const fileContent = readResult?.content || 'NO_CONTENT';

  return {
    content: null,
    toolCalls: [
      { id: `stream-kill-${callCount}`, name: 'bash_kill', args: { id: jobId } },
      { id: `stream-reply-${callCount}`, name: 'reply', args: { source, content: 'STREAM_CONTENT:' + fileContent } },
      { id: `stream-wait-${callCount}`, name: 'wait_for', args: {} },
    ],
    usage: { input: 10, output: 10 },
  };
}

// ---- Spawn agent scenario ----

const CHILD_PORT = 3199;

function spawnScenario() {
  // Step 1: clone workspace + write child routes + write parent routes
  return {
    content: null,
    toolCalls: [
      {
        id: `spawn-clone-${callCount}`,
        name: 'bash',
        args: {
          command:
            'mkdir -p /workspace-child && ' +
            'cp -r /workspace/scripts /workspace-child/ && ' +
            'cp -r /workspace/skills /workspace-child/ && ' +
            'cp /workspace/agent.json /workspace-child/ && ' +
            'cp /workspace/repair.json /workspace-child/ && ' +
            'mkdir -p /workspace-child/memory /workspace-child/history /workspace-child/outbox && ' +
            "echo '[]' > /workspace-child/memory/context.json && " +
            'echo CLONE_OK',
        },
      },
      {
        id: `spawn-child-routes-${callCount}`,
        name: 'write_file',
        args: {
          path: '/workspace-child/routes.json',
          content: JSON.stringify({ 'child-1': { url: 'http://localhost:3000/message' } }, null, 2),
        },
      },
    ],
    usage: { input: 10, output: 10 },
  };
}

function spawnFollowUp(messages, source) {
  // Check what stage we're in by looking at what tools have been called
  const assistantMsgs = messages.filter((m) => m.role === 'assistant');

  // Did we already start the child agent?
  const alreadyStarted = assistantMsgs.some(
    (m) => m.toolCalls?.some((tc) => tc.name === 'bash' && tc.args?.command?.includes('dist/index.js /workspace-child'))
  );

  if (!alreadyStarted) {
    // Step 2: update parent routes + start child agent (async bash)
    return {
      content: null,
      toolCalls: [
        {
          id: `spawn-parent-routes-${callCount}`,
          name: 'write_file',
          args: {
            path: '/workspace/routes.json',
            content: JSON.stringify({
              'mock-im': { url: 'http://localhost:3001/reply' },
              'child-1': { url: 'http://localhost:' + CHILD_PORT + '/message' },
            }, null, 2),
          },
        },
        {
          id: `spawn-start-${callCount}`,
          name: 'bash',
          args: {
            command: 'PORT=' + CHILD_PORT + ' node /app/dist/index.js /workspace-child',
            async: true,
          },
        },
      ],
      usage: { input: 10, output: 10 },
    };
  }

  // Did we already send the health check?
  const alreadyHealthCheck = assistantMsgs.some(
    (m) => m.toolCalls?.some((tc) => tc.name === 'bash' && tc.args?.command?.includes('curl'))
  );

  if (!alreadyHealthCheck) {
    // Step 3: wait for child to be ready, then send a message
    return {
      content: null,
      toolCalls: [
        {
          id: `spawn-health-${callCount}`,
          name: 'bash',
          args: {
            command: 'for i in $(seq 1 20); do curl -sf http://localhost:' + CHILD_PORT + '/status && break; sleep 0.5; done',
          },
        },
      ],
      usage: { input: 10, output: 10 },
    };
  }

  // Did we already send the message to the child?
  const alreadySentToChild = assistantMsgs.some(
    (m) => m.toolCalls?.some((tc) => tc.name === 'reply' && tc.args?.source?.startsWith('child-1:'))
  );

  if (!alreadySentToChild) {
    // Step 4: send message to child + wait for reply
    return {
      content: null,
      toolCalls: [
        {
          id: `spawn-msg-${callCount}`,
          name: 'reply',
          args: { source: 'child-1:test-ping', content: 'CHILD_PING' },
        },
        {
          id: `spawn-wait-${callCount}`,
          name: 'wait_for',
          args: {},
        },
      ],
      usage: { input: 10, output: 10 },
    };
  }

  // Default: shouldn't reach here
  return {
    content: null,
    toolCalls: [{ id: `spawn-wait-default-${callCount}`, name: 'wait_for', args: {} }],
    usage: { input: 0, output: 0 },
  };
}

function spawnChildReply(messages, source) {
  // Child replied. Extract the bash job id to kill the child.
  const toolResults = messages.filter((m) => m.role === 'tool');
  const asyncResult = toolResults.find((m) =>
    m.content?.includes('running in background') && m.content?.includes('dist/index.js')
  );
  const jobIdMatch = asyncResult?.content?.match(/job: ([a-f0-9]+)/);
  const jobId = jobIdMatch?.[1] || 'unknown';

  const origMsg = findUserMessage(messages, 'SPAWN_TEST');
  const origSource = sourceOf(origMsg);

  return {
    content: null,
    toolCalls: [
      { id: `spawn-kill-${callCount}`, name: 'bash_kill', args: { id: jobId } },
      { id: `spawn-reply-${callCount}`, name: 'reply', args: { source: origSource, content: 'SPAWN_COMPLETE' } },
      { id: `spawn-wait-${callCount}`, name: 'wait_for', args: {} },
    ],
    usage: { input: 10, output: 10 },
  };
}

// ---- Repair scenario ----

const FIXED_PROVIDER = `
export default {
  async chat(messages, tools, config) {
    const userMsgs = messages.filter(m => m.role === 'user' && typeof m.content === 'string');
    const lastUser = userMsgs[userMsgs.length - 1];
    const source = lastUser?.content?.match(/^\\[([^\\]]+)\\]/)?.[1] || 'unknown';
    return {
      content: null,
      toolCalls: [
        { id: 'repaired-reply', name: 'reply', args: { source, content: 'REPAIR_WORKED' } },
        { id: 'repaired-wait', name: 'wait_for', args: {} },
      ],
      usage: { input: 0, output: 0 },
    };
  },
};
`.trim();

function handleRepair(messages) {
  // Check if we already have a tool result (meaning we already did read_file)
  const hasToolResult = messages.some((m) => m.role === 'tool');
  if (!hasToolResult) {
    // First call: read the broken provider
    return {
      content: null,
      toolCalls: [
        { id: `repair-read-${callCount}`, name: 'read_file', args: { path: '/workspace/scripts/providers/mock-features.js' } },
      ],
      usage: { input: 10, output: 10 },
    };
  }
  // Second call: write the fixed provider
  return {
    content: null,
    toolCalls: [
      { id: `repair-write-${callCount}`, name: 'write_file', args: { path: '/workspace/scripts/providers/mock-features.js', content: FIXED_PROVIDER } },
    ],
    usage: { input: 10, output: 10 },
  };
}

// ---- Main handler ----

function handleToolResult(messages) {
  // After BASH_KILL_TEST bash went async: kill it
  const killMsg = findUserMessage(messages, 'BASH_KILL_TEST');
  if (killMsg) {
    const alreadyKilled = messages.some(
      (m) => m.role === 'assistant' && m.toolCalls?.some((tc) => tc.name === 'bash_kill')
    );
    if (!alreadyKilled) {
      return bashKillFollowUp(messages, sourceOf(killMsg));
    }
  }

  // After STREAMING_TEST bash went async: read output, then kill + reply
  const streamMsg = findUserMessage(messages, 'STREAMING_TEST');
  if (streamMsg) {
    const alreadyReplied = messages.some(
      (m) => m.role === 'assistant' && m.toolCalls?.some(
        (tc) => tc.name === 'reply' && tc.args?.content?.startsWith('STREAM_CONTENT:')
      )
    );
    if (!alreadyReplied) {
      return streamingFollowUp(messages, sourceOf(streamMsg));
    }
  }

  // After MODEL_SWITCH_TEST read_file: do write_file follow-up
  const switchMsg = findUserMessage(messages, 'MODEL_SWITCH_TEST');
  if (switchMsg) {
    const alreadyWrote = messages.some(
      (m) => m.role === 'assistant' && m.toolCalls?.some(
        (tc) => tc.name === 'write_file' && tc.args?.path === '/workspace/agent.json'
      )
    );
    if (!alreadyWrote) {
      return modelSwitchFollowUp(messages, sourceOf(switchMsg));
    }
  }

  // After SPAWN_TEST: drive through the multi-step spawn flow
  const spawnMsg = findUserMessage(messages, 'SPAWN_TEST');
  if (spawnMsg) {
    const alreadyRepliedSpawn = messages.some(
      (m) => m.role === 'assistant' && m.toolCalls?.some(
        (tc) => tc.name === 'reply' && tc.args?.content === 'SPAWN_COMPLETE'
      )
    );
    if (!alreadyRepliedSpawn) {
      return spawnFollowUp(messages, sourceOf(spawnMsg));
    }
  }

  // Default: wait_for
  return {
    content: null,
    toolCalls: [{ id: `wait-${callCount}`, name: 'wait_for', args: {} }],
    usage: { input: 0, output: 0 },
  };
}

export default {
  async chat(messages, tools, config) {
    callCount++;

    // Detect repair mode: user messages contain [system:repair]
    const isRepair = messages.some(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('[system:repair]')
    );
    if (isRepair) return handleRepair(messages);

    const lastMsg = messages[messages.length - 1];

    // Find last user message
    const userMessages = messages.filter((m) => m.role === 'user' && typeof m.content === 'string');
    const lastUserMsg = userMessages[userMessages.length - 1];
    const { source, text } = extractSource(lastUserMsg?.content ?? '');

    // Follow-up after tool results
    if (lastMsg.role === 'tool') {
      return handleToolResult(messages);
    }

    // system:bash notification → acknowledge async completion
    if (source === 'system:bash') {
      // For ASYNC_BASH_TEST: reply with ASYNC_COMPLETE (only once — prevents re-trigger in later tests)
      const alreadyRepliedAsync = messages.some(
        (m) => m.role === 'assistant' && m.toolCalls?.some(
          (tc) => tc.name === 'reply' && tc.args?.content === 'ASYNC_COMPLETE'
        )
      );
      if (findUserMessage(messages, 'ASYNC_BASH_TEST') && !alreadyRepliedAsync) {
        return systemBashScenario(messages);
      }
      // For BASH_KILL_TEST / STREAMING_TEST / SPAWN_TEST: just wait
      return {
        content: null,
        toolCalls: [{ id: `sysbash-wait-${callCount}`, name: 'wait_for', args: {} }],
        usage: { input: 0, output: 0 },
      };
    }

    // Child agent reply (from spawn test) — only in parent context (has SPAWN_TEST)
    if (source.startsWith('child-1:') && findUserMessage(messages, 'SPAWN_TEST')) {
      return spawnChildReply(messages, source);
    }

    // Keyword dispatch
    if (text.includes('PARALLEL_TEST')) return parallelScenario(source);
    if (text.includes('ASYNC_BASH_TEST')) return asyncBashScenario();
    if (text.includes('BASH_KILL_TEST')) return bashKillScenario();
    if (text.includes('STREAMING_TEST')) return streamingScenario();
    if (text.includes('ROUTE_BRIDGE_TEST')) return routeBridgeScenario(source);
    if (text.includes('MODEL_SWITCH_TEST')) return modelSwitchScenario();
    if (text.includes('SPAWN_TEST')) return spawnScenario();

    // Default: echo reply + wait_for
    return {
      content: null,
      toolCalls: [
        { id: `reply-${callCount}`, name: 'reply', args: { source, content: `Echo: ${text}` } },
        { id: `wait-${callCount}`, name: 'wait_for', args: {} },
      ],
      usage: { input: 100, output: 50 },
    };
  },
};
