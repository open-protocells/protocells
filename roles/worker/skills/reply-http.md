# Reply to HTTP Messages

Messages with source `http:*` come from the agent's HTTP API. Callers poll `GET /outbox` to read replies.

To reply:
```
reply({ source: "http:xxx", content: "your reply" })
```

The system automatically writes the reply to the outbox.
