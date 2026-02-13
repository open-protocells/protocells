import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProviderScript, ToolScript } from './types.js';

export async function loadProvider(scriptPath: string): Promise<ProviderScript> {
  const url = pathToFileURL(scriptPath).href + '?t=' + Date.now();
  const mod = await import(url);
  return mod.default as ProviderScript;
}

export async function loadTools(toolsDir: string): Promise<ToolScript[]> {
  if (!fs.existsSync(toolsDir)) return [];
  const files = fs.readdirSync(toolsDir).filter((f) => f.endsWith('.js'));
  const tools: ToolScript[] = [];

  for (const file of files) {
    const scriptPath = path.join(toolsDir, file);
    const url = pathToFileURL(scriptPath).href + '?t=' + Date.now();
    const mod = await import(url);
    tools.push(mod.default as ToolScript);
  }

  return tools;
}

export async function testLoadAllScripts(workspacePath: string): Promise<void> {
  // Load agent.json to find the active provider
  const agentJsonPath = path.join(workspacePath, 'agent.json');
  const agentState = JSON.parse(fs.readFileSync(agentJsonPath, 'utf-8'));
  const providerFile = path.join(workspacePath, 'scripts', 'providers', `${agentState.provider}.js`);

  // Test active provider only (other providers may fail without API keys at module level)
  await loadProvider(providerFile);

  // Test all tools
  const toolsDir = path.join(workspacePath, 'scripts', 'tools');
  if (fs.existsSync(toolsDir)) {
    await loadTools(toolsDir);
  }
}
