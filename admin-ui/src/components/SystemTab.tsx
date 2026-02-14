import { useEffect, useState, useCallback } from 'react';
import type { SystemInfo } from '../hooks/useApi';
import { fetchSystemInfo, fmtBytes, fmtUptime } from '../hooks/useApi';

interface SystemTabProps {
  active: boolean;
}

export function SystemTab({ active }: SystemTabProps) {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setInfo(await fetchSystemInfo());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    refresh();
    const id = setInterval(refresh, 10000);
    return () => clearInterval(id);
  }, [active, refresh]);

  if (error) {
    return (
      <div style={styles.container}>
        <Card title="Error">
          <pre style={styles.pre}>{error}</pre>
        </Card>
      </div>
    );
  }

  if (!info) return <div style={styles.container}>Loading...</div>;

  const m = info.memory;
  const memPct = Math.round((m.system.used / m.system.total) * 100);
  const barColor = memPct > 90 ? 'var(--red)' : memPct > 70 ? 'var(--yellow)' : 'var(--accent)';

  return (
    <div style={styles.container}>
      <Card title="Memory">
        <div style={styles.barBg}>
          <div style={{ ...styles.barFill, width: `${memPct}%`, background: barColor }} />
        </div>
        <pre style={styles.pre}>
          {`System: ${fmtBytes(m.system.used)} / ${fmtBytes(m.system.total)} (${memPct}%)
Process RSS: ${fmtBytes(m.process.rss)}
Heap: ${fmtBytes(m.process.heapUsed)} / ${fmtBytes(m.process.heapTotal)}
External: ${fmtBytes(m.process.external)}`}
        </pre>
      </Card>

      <Card title="Disk">
        <pre style={styles.pre}>{info.disk}</pre>
      </Card>

      <Card title="Processes">
        <pre style={{ ...styles.pre, maxHeight: 300, overflowY: 'auto' }}>
          {info.processes}
        </pre>
      </Card>

      <Card title="Uptime">
        <pre style={styles.pre}>
          {`Process: ${fmtUptime(info.uptime.process)}
System: ${fmtUptime(info.uptime.system)}`}
        </pre>
      </Card>

      <Card title="Platform">
        <pre style={styles.pre}>
          {`${info.platform.platform} ${info.platform.arch}
Node ${info.platform.nodeVersion}
${info.platform.cpus} CPUs`}
        </pre>
      </Card>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={styles.card}>
      <h3 style={styles.cardTitle}>{title}</h3>
      {children}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: 20,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    overflowY: 'auto',
  },
  card: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '14px 16px',
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-primary)',
    marginBottom: 8,
  },
  pre: {
    fontSize: 11,
    color: 'var(--text-tertiary)',
    whiteSpace: 'pre-wrap',
    lineHeight: '1.6',
    fontFamily: 'var(--font-mono)',
  },
  barBg: { height: 6, background: 'var(--bg-tertiary)', borderRadius: 3, margin: '6px 0' },
  barFill: { height: '100%', borderRadius: 3, transition: 'width 0.3s' },
};
