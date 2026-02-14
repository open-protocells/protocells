import { useEffect, useState, useCallback } from 'react';
import type { AgentInfo, SystemInfo } from '../hooks/useApi';
import { fetchAgents, fetchSystemInfo, fmtBytes, fmtUptime } from '../hooks/useApi';
import { AgentCard } from './AgentCard';

interface OverviewTabProps {
  onChat: (agentName: string) => void;
  active: boolean;
}

export function OverviewTab({ onChat, active }: OverviewTabProps) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null);

  const refresh = useCallback(async () => {
    try { setAgents(await fetchAgents()); } catch { /* ignore */ }
    try { setSysInfo(await fetchSystemInfo()); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!active) return;
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [active, refresh]);

  const m = sysInfo?.memory;
  const memPct = m ? Math.round((m.system.used / m.system.total) * 100) : 0;
  const barColor = memPct > 90 ? 'var(--red)' : memPct > 70 ? 'var(--yellow)' : 'var(--accent)';

  return (
    <div style={styles.container}>
      <section>
        <h2 style={styles.sectionTitle}>Agents ({agents.length})</h2>
        <div style={styles.grid}>
          {agents.map((a) => (
            <AgentCard key={a.name} agent={a} onChat={onChat} />
          ))}
        </div>
      </section>

      {sysInfo && (
        <section>
          <h2 style={styles.sectionTitle}>System</h2>
          <div style={styles.statsGrid}>
            <StatCard label="Memory" value={`${memPct}%`} sub={`${fmtBytes(m!.system.used)} / ${fmtBytes(m!.system.total)}`}>
              <div style={styles.barBg}>
                <div style={{ ...styles.barFill, width: `${memPct}%`, background: barColor }} />
              </div>
            </StatCard>
            <StatCard
              label="Process RSS"
              value={fmtBytes(m!.process.rss)}
              sub={`Heap: ${fmtBytes(m!.process.heapUsed)} / ${fmtBytes(m!.process.heapTotal)}`}
            />
            <StatCard
              label="Uptime"
              value={fmtUptime(sysInfo.uptime.process)}
              sub={`System: ${fmtUptime(sysInfo.uptime.system)}`}
            />
            <StatCard
              label="Platform"
              value={`${sysInfo.platform.cpus} CPU`}
              sub={`${sysInfo.platform.platform} ${sysInfo.platform.arch} / Node ${sysInfo.platform.nodeVersion}`}
            />
          </div>
        </section>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  children,
}: {
  label: string;
  value: string;
  sub: string;
  children?: React.ReactNode;
}) {
  return (
    <div style={styles.stat}>
      <div style={styles.statLabel}>{label}</div>
      <div style={styles.statValue}>{value}</div>
      {children}
      <div style={styles.statSub}>{sub}</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: 20, display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' },
  sectionTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-tertiary)',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 10,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: 12,
  },
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: 10,
  },
  stat: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: 12,
  },
  statLabel: { fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 },
  statValue: { fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' },
  statSub: { fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 },
  barBg: { height: 6, background: 'var(--bg-tertiary)', borderRadius: 3, margin: '6px 0' },
  barFill: { height: '100%', borderRadius: 3, transition: 'width 0.3s' },
};
