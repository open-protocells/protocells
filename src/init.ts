import fs from 'node:fs';
import path from 'node:path';
import type { AgentState, RepairConfig } from './types.js';

export function initWorkspace(workspacePath: string): void {
  if (fs.existsSync(path.join(workspacePath, 'agent.json'))) {
    console.log(`[init] workspace already exists at ${workspacePath}`);
    return;
  }

  console.log(`[init] creating workspace at ${workspacePath}`);

  // Create directories
  const dirs = [
    '',
    'scripts/providers',
    'scripts/tools',
    'skills',
    'skills/mock-im',
    'skills/spawn-agent',
    'memory',
    'history',
    'outbox',
  ];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(workspacePath, dir), { recursive: true });
  }

  // agent.json — auto-detect provider from env
  const defaultProvider = process.env.MINIMAX_API_KEY ? 'minimax'
    : process.env.OPENAI_API_KEY ? 'openai'
    : 'anthropic';
  const defaultModels: Record<string, string> = {
    anthropic: 'claude-sonnet-4-20250514',
    openai: 'gpt-4o',
    minimax: 'MiniMax-M2.5',
  };
  const agentState: AgentState = {
    provider: defaultProvider,
    model: defaultModels[defaultProvider],
    round: 0,
    maxRounds: 1000,
    systemPrompt: `You are a helpful AI agent running as a persistent process inside a Linux container. You communicate through a message queue.

Messages are prefixed with [source] indicating origin.

## Delivering replies

Your text output is NOT delivered to users. You MUST use the reply tool:

reply({ source: "the-source", content: "your message" })

Copy the source exactly from the [source] prefix of the incoming message. The system handles routing automatically.

After delivering, call wait_for to sleep unless you have more work to do.

## Core principles

1. NEVER fabricate information. If you don't know something, say so. If you can verify it, verify it FIRST, then answer.
2. You have bash with full internet access (curl, etc.). USE IT to verify facts before answering.
3. Be direct and concise.
4. Use your tools proactively.
5. When you receive a task, use reply() FIRST to acknowledge it and briefly explain your plan, BEFORE starting the work. During multi-step work, send progress updates via reply() every 2-3 tool calls — never do more than 3 tool calls without updating the user.

## Tools

Built-in:
- think: Reason and plan internally. ALWAYS use this instead of text output.
- reply: Send a message to the user. The ONLY way users can see your messages.
- wait_for: Pause until new messages arrive.

User-defined: bash, read_file, write_file, list_files

IMPORTANT: NEVER output plain text. All actions must go through tools. Use think() to reason, reply() to talk to users, wait_for() to sleep.

## Skills

The skills/ directory contains instructions for specific scenarios. Read it when unsure how to handle something.

## Self-configuration

You can inspect and modify your own configuration and behavior:
- \`agent.json\` — Your runtime config. Read it to understand your current setup, modify it to change settings like model.
- \`scripts/providers/\` — LLM provider adapters.
- \`scripts/tools/\` — Your tool implementations. You can modify existing tools or create new ones.

When asked about your config or capabilities, read the relevant files first rather than guessing.`,
  };
  fs.writeFileSync(
    path.join(workspacePath, 'agent.json'),
    JSON.stringify(agentState, null, 2)
  );

  // repair.json
  const repairConfig: RepairConfig = {
    systemPrompt: `You are a repair agent. Your job is to diagnose and fix broken JavaScript scripts that the main AI agent uses.

You can read and write files in the scripts/ directory. The scripts must be valid ES modules (.js) with a default export.

Provider scripts must export: { chat(messages, tools, config) → Promise<{ content, toolCalls, usage }> }
Tool scripts must export: { name, description, parameters, execute(args) → Promise<{ result, action? }> }

Diagnose the error, read the broken script, fix it, and write it back. Be minimal in your changes.`,
  };
  fs.writeFileSync(
    path.join(workspacePath, 'repair.json'),
    JSON.stringify(repairConfig, null, 2)
  );

  // Default provider script: anthropic.js
  fs.writeFileSync(
    path.join(workspacePath, 'scripts/providers/anthropic.js'),
    ANTHROPIC_PROVIDER_SCRIPT
  );

  // Default provider script: openai.js
  fs.writeFileSync(
    path.join(workspacePath, 'scripts/providers/openai.js'),
    OPENAI_PROVIDER_SCRIPT
  );

  // Default provider script: minimax.js
  fs.writeFileSync(
    path.join(workspacePath, 'scripts/providers/minimax.js'),
    MINIMAX_PROVIDER_SCRIPT
  );

  // Default tool scripts
  fs.writeFileSync(path.join(workspacePath, 'scripts/tools/bash.js'), BASH_TOOL_SCRIPT);
  fs.writeFileSync(path.join(workspacePath, 'scripts/tools/bash-kill.js'), BASH_KILL_TOOL_SCRIPT);
  fs.writeFileSync(path.join(workspacePath, 'scripts/tools/read-file.js'), READ_FILE_TOOL_SCRIPT);
  fs.writeFileSync(path.join(workspacePath, 'scripts/tools/write-file.js'), WRITE_FILE_TOOL_SCRIPT);
  fs.writeFileSync(path.join(workspacePath, 'scripts/tools/list-files.js'), LIST_FILES_TOOL_SCRIPT);

  // Default skill files
  fs.writeFileSync(
    path.join(workspacePath, 'skills/README.md'),
    SKILLS_README
  );
  fs.writeFileSync(
    path.join(workspacePath, 'skills/reply-http.md'),
    REPLY_HTTP_SKILL
  );

  // Mock IM bridge skill
  fs.writeFileSync(
    path.join(workspacePath, 'skills/mock-im/README.md'),
    MOCK_IM_README
  );
  fs.writeFileSync(
    path.join(workspacePath, 'skills/mock-im/setup.sh'),
    MOCK_IM_SETUP_SH
  );
  fs.writeFileSync(
    path.join(workspacePath, 'skills/mock-im/server.js'),
    MOCK_IM_SERVER_SCRIPT
  );

  // Spawn agent skill
  fs.writeFileSync(
    path.join(workspacePath, 'skills/spawn-agent/README.md'),
    SPAWN_AGENT_SKILL
  );

  // Empty routes (bridges register themselves via setup.sh)
  fs.writeFileSync(
    path.join(workspacePath, 'routes.json'),
    '{}'
  );

  // Empty context
  fs.writeFileSync(
    path.join(workspacePath, 'memory/context.json'),
    '[]'
  );

  console.log('[init] workspace created successfully');
}

// ============================================================
// Default script templates
// ============================================================

const ANTHROPIC_PROVIDER_SCRIPT = `import Anthropic from '@anthropic-ai/sdk';

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
`;

const OPENAI_PROVIDER_SCRIPT = `import OpenAI from 'openai';

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

    const choice = response.choices[0];
    const toolCalls = choice.message.tool_calls?.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      args: JSON.parse(tc.function.arguments),
    }));

    return {
      content: choice.message.content,
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : null,
      usage: response.usage
        ? { input: response.usage.prompt_tokens, output: response.usage.completion_tokens }
        : undefined,
    };
  },
};
`;

const MINIMAX_PROVIDER_SCRIPT = `import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.MINIMAX_API_KEY,
  baseURL: 'https://api.minimax.io/v1',
});

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

    const choice = response.choices[0];
    const toolCalls = choice.message.tool_calls?.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      args: JSON.parse(tc.function.arguments),
    }));

    return {
      content: choice.message.content,
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : null,
      usage: response.usage
        ? { input: response.usage.prompt_tokens, output: response.usage.completion_tokens }
        : undefined,
    };
  },
};
`;

const BASH_TOOL_SCRIPT = `import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const OUTPUT_DIR = '/workspace/.tool-output';
const MAX_INLINE_LINES = 100;
const ASYNC_THRESHOLD_MS = 5000;
const AGENT_PORT = process.env.PORT || '3000';

// Global registry of running background jobs (shared with bash_kill tool via globalThis)
if (!globalThis.__bashJobs) globalThis.__bashJobs = new Map();
const jobs = globalThis.__bashJobs;

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function formatResult(output) {
  if (!output) return '(no output)';
  const lines = output.split('\\n');
  if (lines.length <= MAX_INLINE_LINES) return output;
  ensureOutputDir();
  const id = crypto.randomUUID().slice(0, 8);
  const filePath = path.join(OUTPUT_DIR, id + '.txt');
  fs.writeFileSync(filePath, output);
  const preview = lines.slice(0, 50).join('\\n');
  return preview + '\\n\\n[Output truncated: ' + lines.length + ' lines total. Full output saved to ' + filePath + '. Use read_file with offset/limit to read more.]';
}

export default {
  name: 'bash',
  description: 'Execute a shell command. Short commands return inline. Commands taking longer than 5 seconds run in background with output streamed to a file — you can read_file on the output path at any time to see latest output, and use bash_kill to cancel. Set async=true to immediately run in background (useful for long-lived processes like servers).',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 60000)' },
      async: { type: 'boolean', description: 'If true, immediately run in background without waiting for the 5s threshold' },
    },
    required: ['command'],
  },
  async execute(args) {
    const { command, timeout = 60000 } = args;
    const forceAsync = args.async || false;
    const jobId = crypto.randomUUID().slice(0, 8);

    return new Promise((resolve) => {
      let resolved = false;
      let inlineStdout = '', inlineStderr = '';

      // Prepare output file for streaming (created immediately, written to in real-time)
      ensureOutputDir();
      const outputPath = path.join(OUTPUT_DIR, jobId + '.txt');
      const fd = fs.openSync(outputPath, 'w');

      const child = exec(command, {
        timeout,
        maxBuffer: 50 * 1024 * 1024,
        encoding: 'utf-8',
      });

      // Stream output to file in real-time AND accumulate for inline return
      child.stdout?.on('data', (d) => {
        inlineStdout += d;
        fs.writeSync(fd, d);
      });
      child.stderr?.on('data', (d) => {
        inlineStderr += d;
        fs.writeSync(fd, '[stderr] ' + d);
      });

      // After threshold (or immediately if forceAsync), go async
      const thresholdMs = forceAsync ? 0 : ASYNC_THRESHOLD_MS;
      const asyncTimer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        // Register in global jobs map so bash_kill can find it
        jobs.set(jobId, { child, outputPath, command });
        const preview = inlineStdout.slice(-500);
        resolve({
          result: 'Command running in background (job: ' + jobId + ', output: ' + outputPath + '). You can read_file(' + outputPath + ') at any time to see latest output, or bash_kill(' + jobId + ') to cancel. You will receive a [system:bash] message when it completes.' + (preview ? '\\nLatest output:\\n' + preview : ''),
        });
      }, thresholdMs);

      function cleanup(exitCode) {
        clearTimeout(asyncTimer);
        // Write exit status to output file
        fs.writeSync(fd, '\\n[exit code: ' + (exitCode ?? 'unknown') + ']\\n');
        fs.closeSync(fd);
        jobs.delete(jobId);
      }

      child.on('close', (code) => {
        if (!resolved) {
          // Completed within threshold — return inline, clean up file
          resolved = true;
          clearTimeout(asyncTimer);
          fs.closeSync(fd);
          const output = code === 0
            ? inlineStdout
            : 'Exit code: ' + code + '\\nStderr: ' + (inlineStderr || '') + '\\nStdout: ' + (inlineStdout || '');
          // Remove streaming file since we return inline
          try { fs.unlinkSync(outputPath); } catch {}
          resolve({ result: formatResult(output) });
        } else {
          // Was async — output already in file, notify agent
          cleanup(code);
          fetch('http://localhost:' + AGENT_PORT + '/message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: 'Background job ' + jobId + ' finished (exit ' + (code ?? 'unknown') + '). Full output: ' + outputPath,
              source: 'system:bash',
            }),
          }).catch(() => {});
        }
      });

      child.on('error', (err) => {
        clearTimeout(asyncTimer);
        if (!resolved) {
          resolved = true;
          fs.closeSync(fd);
          try { fs.unlinkSync(outputPath); } catch {}
          resolve({ result: 'ERROR: ' + err.message });
        } else {
          fs.writeSync(fd, '\\n[error] ' + err.message + '\\n');
          cleanup(null);
        }
      });
    });
  },
};
`;

const BASH_KILL_TOOL_SCRIPT = `
if (!globalThis.__bashJobs) globalThis.__bashJobs = new Map();
const jobs = globalThis.__bashJobs;

export default {
  name: 'bash_kill',
  description: 'Kill a running background bash job by its job ID. Returns the output captured so far.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The job ID returned by bash when it went async' },
    },
    required: ['id'],
  },
  async execute(args) {
    const { id } = args;
    const job = jobs.get(id);
    if (!job) {
      return { result: 'No running job with id: ' + id + '. It may have already completed.' };
    }
    try {
      job.child.kill('SIGTERM');
      // Give it a moment, then force kill if needed
      setTimeout(() => { try { job.child.kill('SIGKILL'); } catch {} }, 2000);
    } catch (err) {
      return { result: 'Failed to kill job ' + id + ': ' + err.message };
    }
    return { result: 'Job ' + id + ' killed. Output was being streamed to: ' + job.outputPath };
  },
};
`;

const READ_FILE_TOOL_SCRIPT = `import fs from 'node:fs';

export default {
  name: 'read_file',
  description: 'Read a file from the filesystem. Supports reading specific line ranges with offset and limit.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative path to the file' },
      offset: { type: 'number', description: 'Start reading from this line number (0-based, default 0)' },
      limit: { type: 'number', description: 'Maximum number of lines to read (default: 200)' },
    },
    required: ['path'],
  },
  async execute(args) {
    const { path: filePath, offset = 0, limit = 200 } = args;
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\\n');
      const totalLines = lines.length;
      const start = Math.max(0, Math.min(offset, totalLines));
      const slice = lines.slice(start, start + limit);
      const header = \`[Lines \${start}-\${start + slice.length} of \${totalLines} total]\`;
      return { result: header + '\\n' + slice.join('\\n') };
    } catch (err) {
      return { result: \`ERROR: \${err.message}\` };
    }
  },
};
`;

const WRITE_FILE_TOOL_SCRIPT = `import fs from 'node:fs';
import path from 'node:path';

export default {
  name: 'write_file',
  description: 'Write content to a file. Creates parent directories if needed.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative path to the file' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
  async execute(args) {
    const { path: filePath, content } = args;
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, content);
      return { result: \`OK: wrote \${filePath}\` };
    } catch (err) {
      return { result: \`ERROR: \${err.message}\` };
    }
  },
};
`;

const LIST_FILES_TOOL_SCRIPT = `import fs from 'node:fs';
import path from 'node:path';

export default {
  name: 'list_files',
  description: 'List files and directories at the given path.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path to list (default: current directory)' },
      recursive: { type: 'boolean', description: 'List recursively (default: false)' },
    },
  },
  async execute(args) {
    const { path: dirPath = '.', recursive = false } = args;
    try {
      if (recursive) {
        const result = listRecursive(dirPath, '');
        return { result: result.join('\\n') || '(empty directory)' };
      }
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const result = entries.map(e => e.isDirectory() ? e.name + '/' : e.name);
      return { result: result.join('\\n') || '(empty directory)' };
    } catch (err) {
      return { result: \`ERROR: \${err.message}\` };
    }
  },
};

function listRecursive(dir, prefix) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      result.push(rel + '/');
      result.push(...listRecursive(path.join(dir, entry.name), rel));
    } else {
      result.push(rel);
    }
  }
  return result;
}
`;

const SKILLS_README = `# Skills Directory

This directory contains skill files that teach the agent how to handle specific scenarios.

## Naming Convention

Skill files follow the pattern: \`{action}-{target}.md\`

Examples:
- \`reply-http.md\` - How to reply to HTTP messages
- \`reply-feishu.md\` - How to reply to Feishu messages
- \`deploy-docker.md\` - How to deploy with Docker

## How It Works

- The agent reads skill files when it needs guidance on a specific task
- The agent can create new skill files to remember things for the future
- Skill files are plain markdown - easy to read and edit

## Available Skills

- \`reply-http.md\` - How to reply to HTTP API messages
- \`mock-im/\` - Mock IM bridge (chat UI for testing)
- \`spawn-agent/\` - How to spawn and manage sub-agents
`;

const REPLY_HTTP_SKILL = `# Reply to HTTP Messages

Messages with source \`http:*\` come from the agent's HTTP API. Callers poll \`GET /outbox\` to read replies.

To reply:
\`\`\`
reply({ source: "http:xxx", content: "your reply" })
\`\`\`

The system automatically writes the reply to the outbox.
`;

// ============================================================
// Spawn Agent Skill
// ============================================================

const SPAWN_AGENT_SKILL = `# Spawning Sub-Agents

You can spawn independent child agents to delegate tasks. Each child runs as a separate process with its own workspace, context, and LLM calls.

## Overview

1. Clone your workspace to a new directory
2. Set up bidirectional routes for communication
3. Start the child agent via bash (use async: true)
4. Communicate via reply()
5. Stop the child via bash_kill()

## Step 1: Clone Workspace

Copy scripts, skills, and config to a new directory. Skip transient state (memory, history, outbox).

\`\`\`
bash({
  command: "mkdir -p /child-workspace && " +
    "cp -r $WORKSPACE/scripts /child-workspace/ && " +
    "cp -r $WORKSPACE/skills /child-workspace/ && " +
    "cp $WORKSPACE/agent.json /child-workspace/ && " +
    "cp $WORKSPACE/repair.json /child-workspace/ && " +
    "mkdir -p /child-workspace/memory /child-workspace/history /child-workspace/outbox && " +
    "echo '[]' > /child-workspace/memory/context.json"
})
\`\`\`

Optionally modify the child's agent.json (e.g. different system prompt or model).

## Step 2: Set Up Bidirectional Routes

Both parent and child need to route the same prefix (the child's ID) to each other.

Read parent's current routes.json, add the child entry:
\`\`\`
read_file({ path: "$WORKSPACE/routes.json" })
\`\`\`

Then write updated parent routes:
\`\`\`
write_file({ path: "$WORKSPACE/routes.json", content: '{ "mock-im": ..., "my-child": { "url": "http://localhost:CHILD_PORT/message" } }' })
\`\`\`

Write child's routes.json (route the same prefix back to parent):
\`\`\`
write_file({ path: "/child-workspace/routes.json", content: '{ "my-child": { "url": "http://localhost:$PORT/message" } }' })
\`\`\`

Replace \`$PORT\` with your own port (default 3000), and \`CHILD_PORT\` with the child's port.

## Step 3: Choose a Port

Use any unused port (3100, 3200, etc.), or find one dynamically:
\`\`\`
bash({ command: "node -e \\"const s=require('net').createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})\\"" })
\`\`\`

## Step 4: Start Child Agent

Use bash with \`async: true\` to start immediately in background:
\`\`\`
bash({
  command: "PORT=3100 node /app/dist/index.js /child-workspace",
  async: true
})
\`\`\`

This returns immediately with a job ID and output file path. The child agent runs in the background.

Wait for the child to be ready:
\`\`\`
bash({ command: "for i in $(seq 1 20); do curl -sf http://localhost:3100/status && break; sleep 0.5; done" })
\`\`\`

## Step 5: Communicate

Send a message to the child:
\`\`\`
reply({ source: "my-child:task-1", content: "Please research topic X" })
\`\`\`

The child receives \`[my-child:task-1] Please research topic X\` and processes it.

When the child calls \`reply({ source: "my-child:task-1", content: "Here are my findings..." })\`, the reply routes back to your /message endpoint.

You will see it as: \`[my-child:task-1] Here are my findings...\`

## Step 6: Stop Child

Use bash_kill with the job ID from step 4:
\`\`\`
bash_kill({ id: "the-job-id" })
\`\`\`

## Multiple Children

Use different IDs and ports for each child:
- child-researcher on port 3100, routes prefix "child-researcher"
- child-coder on port 3200, routes prefix "child-coder"

Each has independent workspace, context, and communication channel.
`;

// ============================================================
// Mock IM Bridge Skill
// ============================================================

const MOCK_IM_README = `# Mock IM Bridge

A simulated instant messaging bridge that provides a browser-based chat UI.

## How It Works

- Messages from Mock IM have source format: \`mock-im:{sessionId}\`
- The bridge starts automatically via \`setup.sh\`
- Users chat via http://localhost:3001

## Replying

Just use the reply tool with the source from the incoming message:

\`\`\`
reply({ source: "mock-im:abc-123", content: "Hi! How can I help?" })
\`\`\`

The system routes the reply to the correct bridge and session automatically.
`;

const MOCK_IM_SETUP_SH = `#!/bin/sh
BRIDGE_PORT=\${BRIDGE_PORT:-3001}
WORKSPACE=\${WORKSPACE:-/workspace}
ROUTES_FILE="\${WORKSPACE}/routes.json"

# Register route: mock-im → bridge /reply endpoint
node -e "
  const fs = require('fs');
  const routes = fs.existsSync('$ROUTES_FILE') ? JSON.parse(fs.readFileSync('$ROUTES_FILE','utf-8')) : {};
  routes['mock-im'] = { url: 'http://localhost:$BRIDGE_PORT/reply' };
  fs.writeFileSync('$ROUTES_FILE', JSON.stringify(routes, null, 2));
"

node "$(dirname "$0")/server.js" --port "$BRIDGE_PORT" --agent "http://localhost:\${AGENT_PORT:-3000}" &
`;

const MOCK_IM_SERVER_SCRIPT = `import http from 'node:http';
import crypto from 'node:crypto';

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const PORT = parseInt(getArg('--port', '3001'), 10);
const AGENT_URL = getArg('--agent', 'http://localhost:3000');

// Sessions: Map<sessionId, { sseRes, messages[] }>
const sessions = new Map();

function getOrCreateSession(id) {
  if (!sessions.has(id)) sessions.set(id, { sseRes: null, messages: [] });
  return sessions.get(id);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function pushSSE(sessionId, event, data) {
  const s = sessions.get(sessionId);
  if (s?.sseRes && !s.sseRes.destroyed) {
    s.sseRes.write('event: ' + event + '\\ndata: ' + JSON.stringify(data) + '\\n\\n');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost:' + PORT);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    // GET / → Chat UI
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(CHAT_HTML);
      return;
    }

    // GET /events?session=xxx → SSE
    if (req.method === 'GET' && url.pathname === '/events') {
      const sid = url.searchParams.get('session');
      if (!sid) { res.writeHead(400); res.end('session required'); return; }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(':ok\\n\\n');

      const session = getOrCreateSession(sid);
      session.sseRes = res;

      // Replay history
      for (const msg of session.messages) {
        res.write('event: message\\ndata: ' + JSON.stringify(msg) + '\\n\\n');
      }

      req.on('close', () => { if (session.sseRes === res) session.sseRes = null; });
      return;
    }

    // POST /send → User sends message
    if (req.method === 'POST' && url.pathname === '/send') {
      const body = JSON.parse(await readBody(req));
      const { session: sid, content } = body;
      if (!sid || !content) { res.writeHead(400); res.end('session and content required'); return; }

      const session = getOrCreateSession(sid);
      const userMsg = { role: 'user', content, timestamp: Date.now() };
      session.messages.push(userMsg);
      pushSSE(sid, 'message', userMsg);

      // Forward to agent
      const source = 'mock-im:' + sid;
      const agentRes = await fetch(AGENT_URL + '/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, source }),
      });
      const result = await agentRes.json();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, messageId: result.messageId }));
      return;
    }

    // POST /reply → Agent sends reply
    if (req.method === 'POST' && url.pathname === '/reply') {
      const body = JSON.parse(await readBody(req));
      const { source, content } = body;

      const match = source?.match(/^mock-im:(.+)$/);
      if (!match) { res.writeHead(400); res.end('invalid source'); return; }

      const sid = match[1];
      const session = getOrCreateSession(sid);
      const agentMsg = { role: 'assistant', content, timestamp: Date.now() };
      session.messages.push(agentMsg);
      pushSSE(sid, 'message', agentMsg);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET /messages?session=xxx → Fetch session messages (for testing)
    if (req.method === 'GET' && url.pathname === '/messages') {
      const sid = url.searchParams.get('session');
      if (!sid) { res.writeHead(400); res.end('session required'); return; }
      const session = sessions.get(sid);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(session ? session.messages : []));
      return;
    }

    // GET /status → Bridge status
    if (req.method === 'GET' && url.pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ bridge: 'mock-im', sessions: sessions.size, agentUrl: AGENT_URL }));
      return;
    }

    res.writeHead(404); res.end('not found');
  } catch (err) {
    console.error('[mock-im] error:', err);
    res.writeHead(500); res.end(String(err));
  }
});

server.listen(PORT, () => {
  console.log('[mock-im] listening on http://localhost:' + PORT);
  console.log('[mock-im] agent at ' + AGENT_URL);
});

const CHAT_HTML = \`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mock IM - Protocells</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
       background: #f0f2f5; height: 100vh; display: flex; flex-direction: column; }
#header { background: #1a1a2e; color: #fff; padding: 14px 20px;
          display: flex; align-items: center; gap: 12px; }
#header h1 { font-size: 16px; font-weight: 600; }
#header .badge { background: #16213e; padding: 3px 10px; border-radius: 12px;
                 font-size: 12px; color: #7f8c8d; }
#messages { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex;
            flex-direction: column; gap: 8px; }
.msg { max-width: 72%; padding: 10px 14px; border-radius: 16px;
       line-height: 1.5; word-break: break-word; font-size: 14px; }
.msg.user { align-self: flex-end; background: #0084ff; color: #fff;
            border-bottom-right-radius: 4px; }
.msg.assistant { align-self: flex-start; background: #fff; color: #1a1a2e;
                 border: 1px solid #e4e6eb; border-bottom-left-radius: 4px; }
.msg.assistant pre { background: #f6f8fa; padding: 8px; border-radius: 6px;
                     overflow-x: auto; margin: 6px 0; font-size: 13px; }
.msg.assistant code { font-size: 13px; }
.status { text-align: center; color: #8e8e93; font-size: 12px; padding: 4px; }
.typing { align-self: flex-start; color: #8e8e93; font-size: 13px; padding: 4px 14px; }
#input-area { display: flex; padding: 12px 16px; background: #fff;
              border-top: 1px solid #e4e6eb; gap: 8px; }
#input { flex: 1; padding: 10px 16px; border: 1px solid #e4e6eb; border-radius: 24px;
         font-size: 14px; outline: none; resize: none; font-family: inherit;
         max-height: 120px; line-height: 1.4; }
#input:focus { border-color: #0084ff; box-shadow: 0 0 0 2px rgba(0,132,255,0.1); }
#send { background: #0084ff; color: #fff; border: none; border-radius: 24px;
        padding: 10px 20px; font-size: 14px; cursor: pointer; font-weight: 500; }
#send:hover { background: #0073e6; }
#send:disabled { background: #bcc0c4; cursor: not-allowed; }
</style>
</head>
<body>
<div id="header">
  <h1>Mock IM</h1>
  <span class="badge">Protocells Bridge</span>
</div>
<div id="messages"></div>
<div id="input-area">
  <textarea id="input" rows="1" placeholder="Type a message..." ></textarea>
  <button id="send">Send</button>
</div>
<script>
const SID = crypto.randomUUID();
const msgsEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');

const es = new EventSource('/events?session=' + SID);
es.addEventListener('message', e => {
  const msg = JSON.parse(e.data);
  addMsg(msg.role, msg.content);
});
es.onerror = () => addStatus('Reconnecting...');

function addMsg(role, text) {
  const d = document.createElement('div');
  d.className = 'msg ' + role;
  d.textContent = text;
  msgsEl.appendChild(d);
  msgsEl.scrollTop = msgsEl.scrollHeight;
}
function addStatus(text) {
  const d = document.createElement('div');
  d.className = 'status';
  d.textContent = text;
  msgsEl.appendChild(d);
}

async function send() {
  const content = inputEl.value.trim();
  if (!content) return;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  sendBtn.disabled = true;
  try {
    const r = await fetch('/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: SID, content }),
    });
    if (!r.ok) addStatus('Send failed');
  } catch (e) {
    addStatus('Send error: ' + e.message);
  } finally {
    sendBtn.disabled = false;
    inputEl.focus();
  }
}

sendBtn.onclick = send;
inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
});
inputEl.focus();
</script>
</body>
</html>\`;
`;
