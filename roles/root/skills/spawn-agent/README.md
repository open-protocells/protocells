# Spawning Sub-Agents

You can spawn independent child agents to delegate tasks. Each child runs as a separate process with its own workspace, context, and LLM calls.

**You are responsible for repairing any agent you spawn.** If a child crashes or errors, you diagnose and fix it.

## Overview

1. Prepare child workspace from role template
2. Set up bidirectional routes for communication
3. Start the child agent via bash (use async: true)
4. Communicate via reply()
5. Monitor and repair if needed
6. Stop the child via bash_kill()

## Step 1: Prepare Child Workspace

Create the workspace using the role template system. Copy scripts from your workspace and apply the worker role template for skills and prompt:

```
bash({
  command: "mkdir -p /child-workspace && " +
    "cp -r $WORKSPACE/scripts /child-workspace/ && " +
    "cp $WORKSPACE/agent.json /child-workspace/ && " +
    "mkdir -p /child-workspace/memory /child-workspace/history /child-workspace/outbox /child-workspace/skills && " +
    "echo '[]' > /child-workspace/memory/context.json && " +
    "cp -r /app/roles/_base/skills/* /child-workspace/skills/ && " +
    "cp -r /app/roles/worker/skills/* /child-workspace/skills/ && " +
    "cp /app/roles/worker/prompt.md /child-workspace/prompt.md"
})
```

This sets up the child with the **worker** role template. For specialized agents, use a different role path (e.g., `/app/roles/researcher/`).

You can also customize the child's agent.json (e.g., different model) after copying.

## Step 2: Set Up Bidirectional Routes

Both parent and child need to route the same prefix (the child's ID) to each other.

Read parent's current routes.json, add the child entry:
```
read_file({ path: "$WORKSPACE/routes.json" })
```

Then write updated parent routes:
```
write_file({ path: "$WORKSPACE/routes.json", content: '{ "admin": ..., "my-child": { "url": "http://localhost:CHILD_PORT/message" } }' })
```

Write child's routes.json (route the same prefix back to parent):
```
write_file({ path: "/child-workspace/routes.json", content: '{ "my-child": { "url": "http://localhost:$PORT/message" } }' })
```

Replace `$PORT` with your own port (default 3000), and `CHILD_PORT` with the child's port.

## Step 3: Choose a Port

Use any unused port (3100, 3200, etc.), or find one dynamically:
```
bash({ command: "node -e \"const s=require('net').createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})\"" })
```

## Step 4: Start Child Agent

Use bash with `async: true` to start immediately in background. Set REPAIR_AGENT_URL to your own port so the child can notify you of errors:
```
bash({
  command: "PORT=3100 REPAIR_AGENT_URL=http://localhost:$PORT node /app/dist/agent.js /child-workspace",
  async: true
})
```

This returns immediately with a job ID and output file path. The child agent runs in the background.

Wait for the child to be ready:
```
bash({ command: "for i in $(seq 1 20); do curl -sf http://localhost:3100/status && break; sleep 0.5; done" })
```

## Step 5: Communicate

Send a message to the child:
```
reply({ source: "my-child:task-1", content: "Please research topic X" })
```

The child receives `[my-child:task-1] Please research topic X` and processes it.

When the child calls `reply({ source: "my-child:task-1", content: "Here are my findings..." })`, the reply routes back to your /message endpoint.

You will see it as: `[my-child:task-1] Here are my findings...`

## Step 6: Monitor Child

While the child is running, you can check on it:

**Check status:**
```
bash({ command: "curl -sf http://localhost:3100/status" })
```
Returns the child's current status (waiting/running/error), round number, provider, and model.

**Read child logs** (from the async bash output file):
```
read_file({ path: "/workspace/.tool-output/JOB_ID.txt" })
```
Shows real-time stdout/stderr from the child process, including tool calls and errors.

**Read child context** (what the child has been doing):
```
read_file({ path: "/child-workspace/memory/context.json" })
```

**Check child outbox** (unrouted replies):
```
bash({ command: "curl -sf http://localhost:3100/outbox" })
```

## Step 7: Repair Child

You are responsible for repairing any child you spawn. Two failure modes:

### Child enters error state (you receive a repair:worker message)

The child hit an error (script load failure, LLM error, etc.) and is waiting for repair.

1. **Analyze** the error message and stack trace in the notification
2. **Read** the child's scripts: `read_file({ path: "/child-workspace/scripts/..." })`
3. **Read** recent history: `list_files({ path: "/child-workspace/history/", recursive: false })` then read the last few round files
4. **Diagnose** the root cause
5. **Fix** the broken file: `write_file({ path: "/child-workspace/scripts/...", content: "..." })`
6. **Signal** the child to resume: `bash({ command: "curl -X POST http://localhost:CHILD_PORT/repair-signal" })`
7. **Verify** recovery: `bash({ command: "curl -sf http://localhost:CHILD_PORT/status" })`

### Child process crashes (you see a system:bash notification about the job exiting)

The child process exited unexpectedly.

1. **Read** the child's recent history to understand what it was doing
2. **Read** the job output file to check for error messages
3. **Diagnose** the crash cause:
   - Script syntax/runtime error → fix the script
   - State corruption (agent.json / context.json) → repair or reset the file
   - OOM or resource issue → adjust config
4. **Fix** the underlying issue
5. **Restart** the child: `bash({ command: "PORT=CHILD_PORT REPAIR_AGENT_URL=http://localhost:$PORT node /app/dist/agent.js /child-workspace", async: true })`
6. **Verify** recovery: `bash({ command: "for i in $(seq 1 20); do curl -sf http://localhost:CHILD_PORT/status && break; sleep 1; done" })`

**IMPORTANT:** Do NOT blindly restart a crashed child. Always diagnose first. A crash-restart loop helps nobody.

## Step 8: Stop Child

Use bash_kill with the job ID from step 4:
```
bash_kill({ id: "the-job-id" })
```

## Multiple Children

Use different IDs and ports for each child:
- child-researcher on port 3100, routes prefix "child-researcher"
- child-coder on port 3200, routes prefix "child-coder"

Each has independent workspace, context, and communication channel.
