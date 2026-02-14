import type { AgentInfo } from '../hooks/useApi';

interface AgentCardProps {
  agent: AgentInfo;
  onChat: (agentName: string) => void;
}

export function AgentCard({ agent, onChat }: AgentCardProps) {
  const s = agent.status;
  const dotColor = !agent.online
    ? 'var(--red)'
    : s?.status === 'error'
      ? 'var(--yellow)'
      : 'var(--green)';
  const statusText = !agent.online ? 'offline' : s?.status || 'unknown';

  return (
    <div style={styles.card}>
      <h3 style={styles.heading}>
        <span style={{ ...styles.dot, background: dotColor }} />
        {agent.name}
      </h3>
      <div style={styles.rows}>
        <Row label="Status" value={statusText} />
        {s?.round !== undefined && <Row label="Round" value={String(s.round)} />}
        {s?.provider && (
          <Row label="Provider" value={`${s.provider}${s.model ? ` / ${s.model}` : ''}`} />
        )}
        {s?.error && (
          <div style={styles.error}>Error: {s.error.message}</div>
        )}
        <Row label="URL" value={agent.url} />
      </div>
      {agent.online && (
        <button style={styles.btn} onClick={() => onChat(agent.name)}>
          Chat
        </button>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.row}>
      {label}: <b style={styles.bold}>{value}</b>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '14px 16px',
  },
  heading: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-primary)',
    marginBottom: 10,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
    display: 'inline-block',
  },
  rows: {
    fontSize: 12,
    color: 'var(--text-tertiary)',
    lineHeight: '1.9',
  },
  row: {},
  bold: { color: 'var(--text-secondary)', fontWeight: 500 },
  error: { color: 'var(--yellow)' },
  btn: {
    display: 'inline-block',
    marginTop: 8,
    padding: '3px 10px',
    fontSize: 11,
    border: '1px solid var(--border)',
    borderRadius: 4,
    color: 'var(--text-tertiary)',
    background: 'var(--bg-primary)',
    cursor: 'pointer',
  },
};
