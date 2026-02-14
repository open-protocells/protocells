# Admin Dashboard

System-level monitoring and communication process. Started automatically by the orchestrator on port 3001.

## Message Format

- Messages from admin have source format: `admin:{sessionId}`
- Reply using the reply tool with the exact source:

```
reply({ source: "admin:abc-123", content: "Hi! How can I help?" })
```

## Admin API

- Web UI: http://localhost:3001
- GET /agents - List all known agents and their status
- GET /system-info - System monitoring data (memory, disk, uptime)
- GET /status - Admin self status
