import { useState, useCallback } from 'react';
import { OverviewTab } from './components/OverviewTab';
import { ChatTab } from './components/ChatTab';
import { SystemTab } from './components/SystemTab';
import { HistoryTab } from './components/HistoryTab';
import { useSSE } from './hooks/useSSE';

type Tab = 'overview' | 'chat' | 'history' | 'system';

function getSessionId(): string {
  let sid = localStorage.getItem('protocells-sid');
  if (!sid) {
    sid = crypto.randomUUID();
    localStorage.setItem('protocells-sid', sid);
  }
  return sid;
}

const SESSION_ID = getSessionId();

export function App() {
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [targetAgent, setTargetAgent] = useState('root');
  const { connected } = useSSE(SESSION_ID);

  const switchToChat = useCallback((agentName: string) => {
    setTargetAgent(agentName);
    setActiveTab('chat');
  }, []);

  return (
    <>
      <header style={styles.header}>
        <h1 style={styles.title}>PROTOCELLS</h1>
        <span
          style={{
            ...styles.connDot,
            background: connected ? 'var(--green)' : 'var(--red)',
          }}
          title={connected ? 'Connected' : 'Disconnected'}
        />
        <nav style={styles.tabs}>
          {(['overview', 'chat', 'history', 'system'] as Tab[]).map((tab) => (
            <button
              key={tab}
              style={{
                ...styles.tab,
                ...(activeTab === tab ? styles.tabActive : {}),
              }}
              onClick={() => setActiveTab(tab)}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </nav>
      </header>

      <main style={styles.content}>
        {activeTab === 'overview' && (
          <OverviewTab active={activeTab === 'overview'} onChat={switchToChat} />
        )}
        {activeTab === 'chat' && (
          <ChatTab
            active={activeTab === 'chat'}
            sessionId={SESSION_ID}
            targetAgent={targetAgent}
            onAgentChange={setTargetAgent}
          />
        )}
        {activeTab === 'history' && (
          <HistoryTab active={activeTab === 'history'} />
        )}
        {activeTab === 'system' && (
          <SystemTab active={activeTab === 'system'} />
        )}
      </main>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  header: {
    background: 'var(--bg-secondary)',
    padding: '10px 20px',
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    borderBottom: '1px solid var(--border)',
  },
  title: {
    fontSize: 15,
    fontWeight: 600,
    color: 'var(--text-primary)',
    letterSpacing: 0.5,
  },
  connDot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    flexShrink: 0,
    display: 'inline-block',
  },
  tabs: {
    display: 'flex',
    gap: 2,
    marginLeft: 'auto',
  },
  tab: {
    padding: '5px 14px',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--text-tertiary)',
    background: 'transparent',
    border: 'none',
    transition: 'all 0.15s',
  },
  tabActive: {
    color: 'var(--text-primary)',
    background: 'var(--border)',
  },
  content: {
    flex: 1,
    overflow: 'hidden',
  },
};
