# Self-Update Procedure

This skill describes how to propose changes to your own source code (the protocells framework).

## Prerequisites

You may need to install tools first:
```
bash({ command: "apt-get update && apt-get install -y git" })
bash({ command: "curl -fsSL https://get.docker.com | sh" })
```

Or if Docker is already available via socket mount, just install the CLI.

## Workflow

### 1. Clone the Repository

```
bash({ command: "git clone $PROTOCELLS_REPO /tmp/protocells-src" })
bash({ command: "cd /tmp/protocells-src && git checkout -b fix/description-of-change" })
```

The repo URL comes from the `PROTOCELLS_REPO` environment variable.

### 2. Make Changes

Read, understand, and modify the source code:
```
read_file({ path: "/tmp/protocells-src/src/executor.ts" })
write_file({ path: "/tmp/protocells-src/src/executor.ts", content: "..." })
```

### 3. Build and Test

Build the project and run tests inside a fresh container to verify:
```
bash({ command: "cd /tmp/protocells-src && docker build -t protocells-test ." })
bash({ command: "docker run --rm protocells-test pnpm test:mock" })
```

If tests fail, fix and retry.

### 4. Push and Create PR

```
bash({ command: "cd /tmp/protocells-src && git add -A && git commit -m 'fix: description'" })
bash({ command: "cd /tmp/protocells-src && git push -u origin fix/description-of-change" })
```

If `gh` CLI is available:
```
bash({ command: "cd /tmp/protocells-src && gh pr create --title 'fix: description' --body 'Automated fix by repair agent'" })
```

Otherwise, output the PR URL for manual creation.

## Safety Rules

1. **Always create a branch** — never push to main/master directly
2. **Always run tests** — never submit untested changes
3. **Never auto-merge** — PRs require human review
4. **Minimal changes** — only change what's necessary to fix the issue
5. **Clear commit messages** — describe what and why
