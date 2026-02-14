import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  AgentInfo,
  HistoryListResult,
  HistoryRoundDetail,
  HistorySummary,
} from '../hooks/useApi';
import {
  fetchAgents,
  fetchHistoryList,
  fetchHistoryRound,
  fmtTimestamp,
} from '../hooks/useApi';

interface HistoryTabProps {
  active: boolean;
}

const PAGE_SIZE = 20;

export function HistoryTab({ active }: HistoryTabProps) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedAgent, setSelectedAgent] = useState('root');
  const [historyResult, setHistoryResult] = useState<HistoryListResult | null>(null);
  const [offset, setOffset] = useState(0);
  const [details, setDetails] = useState<Map<number, HistoryRoundDetail>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(new Set<number>());

  useEffect(() => {
    if (active) fetchAgents().then(setAgents).catch(() => {});
  }, [active]);

  const refreshList = useCallback(async () => {
    try {
      setError(null);
      const result = await fetchHistoryList(selectedAgent, offset, PAGE_SIZE);
      setHistoryResult(result);
    } catch (e) {
      setError(String(e));
    }
  }, [selectedAgent, offset]);

  useEffect(() => {
    if (!active) return;
    refreshList();
    const id = setInterval(refreshList, 10_000);
    return () => clearInterval(id);
  }, [active, refreshList]);

  // Auto-load details for all visible rounds
  useEffect(() => {
    if (!historyResult) return;
    for (const item of historyResult.items) {
      if (!loadedRef.current.has(item.round)) {
        loadedRef.current.add(item.round);
        fetchHistoryRound(item.round, selectedAgent)
          .then(detail => setDetails(prev => new Map(prev).set(item.round, detail)))
          .catch(() => loadedRef.current.delete(item.round));
      }
    }
  }, [historyResult, selectedAgent]);

  const handleAgentChange = (name: string) => {
    setSelectedAgent(name);
    setOffset(0);
    setDetails(new Map());
    loadedRef.current.clear();
  };

  const totalPages = historyResult ? Math.ceil(historyResult.total / PAGE_SIZE) : 0;
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div style={styles.container}>
      {/* Top bar */}
      <div style={styles.bar}>
        <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>Agent:</span>
        <select
          style={styles.select}
          value={selectedAgent}
          onChange={(e) => handleAgentChange(e.target.value)}
        >
          {agents.map((a) => (
            <option key={a.name} value={a.name}>
              {a.name}{a.online ? '' : ' (offline)'}
            </option>
          ))}
          {agents.length === 0 && <option value="root">root</option>}
        </select>
        {historyResult && (
          <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 11 }}>
            {historyResult.total} rounds
          </span>
        )}
      </div>

      {/* Timeline */}
      <div style={styles.timeline}>
        {error && <div style={styles.error}>{error}</div>}

        {historyResult?.items.map((item) => (
          <RoundCard
            key={item.round}
            item={item}
            detail={details.get(item.round) ?? null}
          />
        ))}

        {historyResult && historyResult.total === 0 && (
          <div style={styles.empty}>No history rounds yet</div>
        )}

        {totalPages > 1 && (
          <div style={styles.pagination}>
            <button
              style={styles.pageBtn}
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Prev
            </button>
            <span style={styles.pageInfo}>{currentPage} / {totalPages}</span>
            <button
              style={styles.pageBtn}
              disabled={offset + PAGE_SIZE >= (historyResult?.total ?? 0)}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Round Card ---

function RoundCard({
  item,
  detail,
}: {
  item: HistorySummary;
  detail: HistoryRoundDetail | null;
}) {
  const userMessages = detail?.messages.filter(m => m.role === 'user') ?? [];
  const assistantContent = detail?.response.content ?? null;
  const toolCalls = detail?.response.toolCalls ?? [];
  const toolResultMap = new Map(
    (detail?.messages ?? [])
      .filter(m => m.role === 'tool' && m.toolCallId)
      .map(m => [m.toolCallId!, m.content ?? ''])
  );

  return (
    <div style={styles.card}>
      {/* Header */}
      <div style={styles.cardHeader}>
        <span style={styles.roundBadge}>#{item.round}</span>
        <span style={styles.cardTime}>{fmtTimestamp(item.timestamp)}</span>
        <span style={styles.cardProvider}>
          {item.provider}{item.model ? ` / ${item.model}` : ''}
        </span>
        {item.usage && (
          <span style={styles.cardTokens}>
            {item.usage.input + item.usage.output} tok
          </span>
        )}
      </div>

      {!detail && <div style={styles.loading}>Loading...</div>}

      {detail && (
        <div style={styles.cardBody}>
          {/* User messages */}
          {userMessages.map((msg, i) => (
            <div key={i} style={styles.section}>
              <div style={styles.sectionLabel}>
                <span style={{ ...styles.roleBadge, background: 'var(--accent)' }}>user</span>
              </div>
              <pre style={styles.contentBlock}>{msg.content}</pre>
            </div>
          ))}

          {/* Assistant text response */}
          {assistantContent && (
            <div style={styles.section}>
              <div style={styles.sectionLabel}>
                <span style={{ ...styles.roleBadge, background: 'var(--green)' }}>assistant</span>
              </div>
              <pre style={styles.contentBlock}>{assistantContent}</pre>
            </div>
          )}

          {/* Tool calls */}
          {toolCalls.map((tc) => (
            <ToolCallBlock
              key={tc.id}
              toolCall={tc}
              result={toolResultMap.get(tc.id) ?? null}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// --- Tool Call Block ---

function ToolCallBlock({
  toolCall,
  result,
}: {
  toolCall: { id: string; name: string; args: unknown };
  result: string | null;
}) {
  const args = (toolCall.args ?? {}) as Record<string, unknown>;
  const name = toolCall.name;

  if (name === 'bash') {
    const command = String(args.command ?? '');
    return (
      <div style={styles.toolBlock}>
        <div style={styles.toolHeader}>
          <span style={styles.toolName}>bash</span>
        </div>
        <pre style={styles.commandBlock}>$ {command}</pre>
        {result && <pre style={styles.scrollBlock}>{result}</pre>}
      </div>
    );
  }

  if (name === 'reply') {
    const content = String(args.content ?? '');
    const source = String(args.source ?? '');
    return (
      <div style={styles.toolBlock}>
        <div style={styles.toolHeader}>
          <span style={styles.toolName}>reply</span>
          {source && <span style={styles.toolMeta}>{'\u2192'} {source}</span>}
        </div>
        <pre style={styles.contentBlock}>{content}</pre>
      </div>
    );
  }

  if (name === 'write_file') {
    const filePath = String(args.path ?? '');
    const content = String(args.content ?? '');
    return (
      <div style={styles.toolBlock}>
        <div style={styles.toolHeader}>
          <span style={styles.toolName}>write_file</span>
          <span style={styles.toolMeta}>{filePath}</span>
        </div>
        <pre style={styles.scrollBlock}>{content}</pre>
      </div>
    );
  }

  if (name === 'read_file') {
    const filePath = String(args.path ?? '');
    return (
      <div style={styles.toolBlock}>
        <div style={styles.toolHeader}>
          <span style={styles.toolName}>read_file</span>
          <span style={styles.toolMeta}>{filePath}</span>
        </div>
        {result && <pre style={styles.scrollBlock}>{result}</pre>}
      </div>
    );
  }

  if (name === 'think') {
    const thought = String(args.thought ?? '');
    return (
      <div style={styles.toolBlock}>
        <div style={styles.toolHeader}>
          <span style={styles.toolName}>think</span>
        </div>
        <pre style={styles.scrollBlock}>{thought}</pre>
      </div>
    );
  }

  if (name === 'wait_for') {
    return (
      <div style={styles.toolBlock}>
        <div style={styles.toolHeader}>
          <span style={styles.toolName}>wait_for</span>
          <span style={styles.toolMeta}>Waiting for new messages</span>
        </div>
      </div>
    );
  }

  if (name === 'list_files') {
    const dirPath = String(args.path ?? '.');
    return (
      <div style={styles.toolBlock}>
        <div style={styles.toolHeader}>
          <span style={styles.toolName}>list_files</span>
          <span style={styles.toolMeta}>{dirPath}</span>
        </div>
        {result && <pre style={styles.scrollBlock}>{result}</pre>}
      </div>
    );
  }

  if (name === 'bash_kill') {
    const jobId = String(args.id ?? '');
    return (
      <div style={styles.toolBlock}>
        <div style={styles.toolHeader}>
          <span style={styles.toolName}>bash_kill</span>
          <span style={styles.toolMeta}>job: {jobId}</span>
        </div>
        {result && <pre style={styles.contentBlock}>{result}</pre>}
      </div>
    );
  }

  // Default: show args + result
  return (
    <div style={styles.toolBlock}>
      <div style={styles.toolHeader}>
        <span style={styles.toolName}>{name}</span>
      </div>
      {Object.keys(args).length > 0 && (
        <pre style={styles.scrollBlock}>{JSON.stringify(args, null, 2)}</pre>
      )}
      {result && (
        <>
          <div style={styles.resultLabel}>Result</div>
          <pre style={styles.scrollBlock}>{result}</pre>
        </>
      )}
    </div>
  );
}

// --- Styles ---

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: '100%' },
  bar: {
    padding: '8px 16px',
    background: 'var(--bg-secondary)',
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
    flexShrink: 0,
  },
  select: {
    background: 'var(--bg-primary)',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border)',
    padding: '4px 8px',
    borderRadius: 4,
    fontSize: 12,
  },
  timeline: {
    flex: 1,
    overflowY: 'auto',
    padding: '12px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  empty: {
    color: 'var(--text-muted)',
    fontSize: 12,
    padding: 20,
    textAlign: 'center' as const,
  },
  error: { color: 'var(--red)', fontSize: 12, padding: '10px 0' },
  pagination: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: '10px 0',
  },
  pageBtn: {
    padding: '3px 10px',
    fontSize: 11,
    border: '1px solid var(--border)',
    borderRadius: 4,
    color: 'var(--text-tertiary)',
    background: 'var(--bg-primary)',
    cursor: 'pointer',
  },
  pageInfo: { fontSize: 11, color: 'var(--text-muted)' },

  // Card
  card: {
    border: '1px solid var(--border)',
    borderRadius: 6,
    background: 'var(--bg-secondary)',
    flexShrink: 0,
  },
  cardHeader: {
    padding: '8px 14px',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    fontSize: 12,
    borderBottom: '1px solid var(--border)',
  },
  roundBadge: {
    fontWeight: 700,
    color: 'var(--text-primary)',
    fontSize: 13,
    fontFamily: 'var(--font-mono)',
  },
  cardTime: { color: 'var(--text-tertiary)', fontSize: 11 },
  cardProvider: { color: 'var(--text-muted)', fontSize: 11 },
  cardTokens: { color: 'var(--text-muted)', fontSize: 11, marginLeft: 'auto' },

  cardBody: {
    padding: '10px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  loading: { color: 'var(--text-muted)', fontSize: 12, padding: '10px 14px' },

  // Section (user / assistant)
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  sectionLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  roleBadge: {
    fontSize: 10,
    fontWeight: 600,
    color: '#fff',
    padding: '1px 5px',
    borderRadius: 3,
    textTransform: 'uppercase' as const,
  },
  contentBlock: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    whiteSpace: 'pre-wrap',
    lineHeight: '1.5',
    fontFamily: 'var(--font-mono)',
    margin: 0,
    padding: '6px 10px',
    background: 'var(--bg-primary)',
    border: '1px solid var(--border)',
    borderRadius: 4,
  },

  // Tool blocks
  toolBlock: {
    border: '1px solid var(--border)',
    borderRadius: 4,
    overflow: 'hidden',
  },
  toolHeader: {
    padding: '4px 10px',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: 'rgba(255,255,255,0.03)',
    borderBottom: '1px solid var(--border)',
    fontSize: 12,
  },
  toolName: {
    fontWeight: 600,
    color: 'var(--yellow)',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    flexShrink: 0,
  },
  toolMeta: {
    color: 'var(--text-muted)',
    fontSize: 11,
    fontFamily: 'var(--font-mono)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    minWidth: 0,
  },
  commandBlock: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    whiteSpace: 'pre-wrap',
    lineHeight: '1.5',
    fontFamily: 'var(--font-mono)',
    margin: 0,
    padding: '6px 10px',
    background: 'var(--bg-primary)',
    borderBottom: '1px solid var(--border)',
  },
  scrollBlock: {
    fontSize: 12,
    color: 'var(--text-tertiary)',
    whiteSpace: 'pre-wrap',
    lineHeight: '1.4',
    fontFamily: 'var(--font-mono)',
    margin: 0,
    padding: '6px 10px',
    background: 'var(--bg-primary)',
    maxHeight: 300,
    overflowY: 'auto',
  },
  resultLabel: {
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
    padding: '4px 10px 0',
    background: 'var(--bg-primary)',
  },
};
