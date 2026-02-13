import fs from 'node:fs';
import path from 'node:path';
import type { Message, LLMResponse } from './types.js';

export interface RoundSnapshot {
  round: number;
  timestamp: number;
  messages: Message[];
  response: LLMResponse;
  provider: string;
  model?: string;
}

export function saveHistory(workspacePath: string, snapshot: RoundSnapshot): void {
  const dir = path.join(workspacePath, 'history');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const filename = `round-${String(snapshot.round).padStart(5, '0')}.json`;
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(snapshot, null, 2));
}
