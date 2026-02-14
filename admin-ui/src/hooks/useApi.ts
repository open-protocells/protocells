export interface AgentInfo {
  name: string;
  url: string;
  online: boolean;
  status: {
    status?: string;
    round?: number;
    provider?: string;
    model?: string;
    error?: { message: string };
    [key: string]: unknown;
  } | null;
}

export interface SystemInfo {
  memory: {
    system: { total: number; free: number; used: number };
    process: { rss: number; heapUsed: number; heapTotal: number; external: number };
  };
  disk: string;
  processes: string;
  uptime: { process: number; system: number };
  platform: { arch: string; platform: string; nodeVersion: string; cpus: number };
}

export async function fetchAgents(): Promise<AgentInfo[]> {
  const res = await fetch('/api/agents');
  return res.json();
}

export async function fetchSystemInfo(): Promise<SystemInfo> {
  const res = await fetch('/api/system-info');
  return res.json();
}

export async function sendMessage(
  session: string,
  content: string,
  agent?: string
): Promise<{ ok: boolean; messageId?: string }> {
  const res = await fetch('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, content, agent: agent || undefined }),
  });
  return res.json();
}

export async function fetchMessages(
  session: string
): Promise<{ role: string; content: string; timestamp: number }[]> {
  const res = await fetch(`/api/messages?session=${session}`);
  return res.json();
}

// --- History Types ---

export interface HistoryToolDetail {
  name: string;
  args: string;
}

export interface HistorySummary {
  round: number;
  timestamp: number;
  provider: string;
  model?: string;
  messageCount: number;
  toolCallCount: number;
  toolNames: string[];
  tools: HistoryToolDetail[];
  userPreview: string;
  assistantPreview: string;
  usage?: { input: number; output: number };
}

export interface HistoryListResult {
  items: HistorySummary[];
  total: number;
  offset: number;
  limit: number;
}

export interface HistoryRoundDetail {
  round: number;
  timestamp: number;
  messages: {
    role: string;
    content: string | null;
    toolCalls?: { id: string; name: string; args: unknown }[];
    toolCallId?: string;
  }[];
  response: {
    content: string | null;
    toolCalls: { id: string; name: string; args: unknown }[] | null;
    usage?: { input: number; output: number };
  };
  provider: string;
  model?: string;
}

export async function fetchHistoryList(
  agent: string = 'root',
  offset: number = 0,
  limit: number = 20
): Promise<HistoryListResult> {
  const res = await fetch(
    `/api/history?agent=${encodeURIComponent(agent)}&offset=${offset}&limit=${limit}`
  );
  if (!res.ok) throw new Error(`Failed to fetch history: ${res.status}`);
  return res.json();
}

export async function fetchHistoryRound(
  round: number,
  agent: string = 'root'
): Promise<HistoryRoundDetail> {
  const res = await fetch(
    `/api/history/${round}?agent=${encodeURIComponent(agent)}`
  );
  if (!res.ok) throw new Error(`Failed to fetch round ${round}: ${res.status}`);
  return res.json();
}

export function fmtTimestamp(ts: number): string {
  return new Date(ts).toLocaleString();
}

export function fmtBytes(b: number): string {
  if (b > 1e9) return (b / 1e9).toFixed(1) + 'G';
  if (b > 1e6) return (b / 1e6).toFixed(0) + 'M';
  return (b / 1e3).toFixed(0) + 'K';
}

export function fmtUptime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}
