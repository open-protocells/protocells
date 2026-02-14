# Skills Directory

This directory contains skill files that teach the agent how to handle specific scenarios.

## Naming Convention

Skill files follow the pattern: `{action}-{target}.md`

Examples:
- `reply-http.md` - How to reply to HTTP messages
- `reply-feishu.md` - How to reply to Feishu messages
- `deploy-docker.md` - How to deploy with Docker

## How It Works

- The agent reads skill files when it needs guidance on a specific task
- The agent can create new skill files to remember things for the future
- Skill files are plain markdown - easy to read and edit

## Available Skills

- `reply-http.md` - How to reply to HTTP API messages
- `admin/` - Admin dashboard (chat, monitoring, agent management)
- `spawn-agent/` - How to spawn, manage, and repair sub-agents
- `self-update/` - How to propose changes to your own source code
