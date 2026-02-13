import fs from 'node:fs';
import path from 'node:path';
import type { AgentState, RepairConfig } from './types.js';

export function loadState(workspacePath: string): AgentState {
  const filePath = path.join(workspacePath, 'agent.json');
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as AgentState;
}

export function saveState(workspacePath: string, state: AgentState): void {
  const filePath = path.join(workspacePath, 'agent.json');
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

export function loadRepairConfig(workspacePath: string): RepairConfig {
  const filePath = path.join(workspacePath, 'repair.json');
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as RepairConfig;
}
