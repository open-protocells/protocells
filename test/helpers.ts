import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const IMAGE_NAME = 'protocells-test';

export interface ContainerInfo {
  id: string;
  port: number;
  bridgePort: number;
  baseUrl: string;
  bridgeUrl: string;
}

// Build Docker image (once)
export function buildImage(): void {
  console.log('[test] building docker image...');
  execSync(`docker build -t ${IMAGE_NAME} .`, {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    timeout: 120_000,
  });
  console.log('[test] image built');
}

// Start a container
export function startContainer(opts: {
  port?: number;
  env?: Record<string, string>;
  mockProvider?: boolean;
  provider?: string; // Switch agent.json to this provider (e.g. 'minimax', 'openai')
}): ContainerInfo {
  const port = opts.port ?? 3000 + Math.floor(Math.random() * 1000);
  const bridgePort = port + 1;
  const envFlags = Object.entries(opts.env ?? {})
    .map(([k, v]) => `-e "${k}=${v}"`)
    .join(' ');

  // Start container (no --rm so we can inspect after crashes)
  const id = execSync(
    `docker run -d -p ${port}:3000 -p ${bridgePort}:3001 ${envFlags} ${IMAGE_NAME}`,
    { encoding: 'utf-8', cwd: PROJECT_ROOT }
  ).trim();

  console.log(`[test] container started: ${id.slice(0, 12)} on port ${port} (bridge: ${bridgePort})`);

  // Wait for workspace init + HTTP server
  execSync('sleep 2');

  if (opts.mockProvider) {
    // Copy all test/mock-provider*.js → providers/mock*.js
    const testDir = path.join(PROJECT_ROOT, 'test');
    const mockFiles = fs.readdirSync(testDir).filter((f) => f.startsWith('mock-provider') && f.endsWith('.js'));
    for (const f of mockFiles) {
      const name = f.replace('mock-provider', 'mock');
      execSync(`docker cp "${path.join(testDir, f)}" ${id}:/workspace/scripts/providers/${name}`);
    }
    switchProvider(id, opts.provider ?? 'mock');
    console.log(`[test] mock providers installed: ${mockFiles.join(', ')}`);
  } else if (opts.provider) {
    switchProvider(id, opts.provider);
    console.log(`[test] provider set to: ${opts.provider}`);
  }

  return {
    id,
    port,
    bridgePort,
    baseUrl: `http://localhost:${port}`,
    bridgeUrl: `http://localhost:${bridgePort}`,
  };
}

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
  minimax: 'MiniMax-M2.5',
};

function switchProvider(containerId: string, provider: string): void {
  const model = DEFAULT_MODELS[provider] ?? '';
  execSync(`docker exec ${containerId} node -e "
    const fs = require('fs');
    const state = JSON.parse(fs.readFileSync('/workspace/agent.json', 'utf-8'));
    state.provider = '${provider}';
    ${model ? `state.model = '${model}';` : ''}
    fs.writeFileSync('/workspace/agent.json', JSON.stringify(state, null, 2));
  "`);
}

// Stop and remove container
export function stopContainer(container: ContainerInfo): void {
  try {
    execSync(`docker rm -f ${container.id}`, { timeout: 10_000, stdio: 'pipe' });
    console.log(`[test] container removed: ${container.id.slice(0, 12)}`);
  } catch {
    // Container may already be gone
  }
}

// HTTP helpers
export async function httpGet(baseUrl: string, urlPath: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${urlPath}`);
  const body = await res.json();
  return { status: res.status, body };
}

export async function httpPost(baseUrl: string, urlPath: string, data: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const body = await res.json();
  return { status: res.status, body };
}

export async function httpDelete(baseUrl: string, urlPath: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${urlPath}`, { method: 'DELETE' });
  const body = await res.json();
  return { status: res.status, body };
}

// Wait for server to be ready
export async function waitForReady(baseUrl: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/status`);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await sleep(500);
  }
  throw new Error(`Server not ready after ${timeoutMs}ms`);
}

// Poll outbox until at least N messages appear
export async function pollOutbox(
  baseUrl: string,
  minCount: number = 1,
  timeoutMs: number = 30_000
): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await httpGet(baseUrl, '/outbox');
    if (Array.isArray(body) && body.length >= minCount) return body;
    await sleep(500);
  }
  throw new Error(`Outbox did not reach ${minCount} messages within ${timeoutMs}ms`);
}

// Poll status until round >= target
export async function pollRound(
  baseUrl: string,
  targetRound: number,
  timeoutMs: number = 30_000
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await httpGet(baseUrl, '/status');
    if (body.round >= targetRound) return body;
    await sleep(500);
  }
  throw new Error(`Round did not reach ${targetRound} within ${timeoutMs}ms`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Poll bridge messages until an assistant reply appears
export async function pollBridgeReply(
  bridgeUrl: string,
  sessionId: string,
  timeoutMs: number = 60_000
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { body } = await httpGet(bridgeUrl, `/messages?session=${sessionId}`);
      if (Array.isArray(body)) {
        const reply = body.find((m: any) => m.role === 'assistant');
        if (reply) return reply;
      }
    } catch {
      // Bridge may not be ready yet
    }
    await sleep(1000);
  }
  throw new Error(`No bridge reply within ${timeoutMs}ms`);
}

// Read a file from inside the container
export function dockerReadFile(containerId: string, filePath: string): string {
  return execSync(`docker exec ${containerId} cat "${filePath}"`, { encoding: 'utf-8' });
}

// Get container logs
export function dockerLogs(containerId: string): string {
  return execSync(`docker logs ${containerId} 2>&1`, { encoding: 'utf-8' });
}
