import { useState, useRef, useEffect, useCallback } from 'react';
import type { AgentInfo } from '../hooks/useApi';
import { fetchAgents, sendMessage } from '../hooks/useApi';
import { useSSE } from '../hooks/useSSE';

interface ChatTabProps {
  active: boolean;
  sessionId: string;
  targetAgent: string;
  onAgentChange: (name: string) => void;
}

export function ChatTab({ active, sessionId, targetAgent, onAgentChange }: ChatTabProps) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { messages, connected } = useSSE(sessionId);

  useEffect(() => {
    fetchAgents().then(setAgents).catch(() => {});
  }, [active]);

  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active]);

  const handleSend = useCallback(async () => {
    const content = input.trim();
    if (!content || sending) return;
    setInput('');
    setSending(true);
    try {
      const result = await sendMessage(sessionId, content, targetAgent);
      if (!result.ok) {
        // Error handled by SSE or ignored
      }
    } catch {
      // Network error
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }, [input, sending, sessionId, targetAgent]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.bar}>
        <span style={{ color: 'var(--text-tertiary)' }}>To:</span>
        <select
          style={styles.select}
          value={targetAgent}
          onChange={(e) => onAgentChange(e.target.value)}
        >
          {agents.map((a) => (
            <option key={a.name} value={a.name}>
              {a.name}
              {a.online ? '' : ' (offline)'}
            </option>
          ))}
          {agents.length === 0 && <option value="root">root</option>}
        </select>
        <span style={styles.chatStatus}>
          {connected ? 'connected' : 'disconnected'}
        </span>
      </div>

      <div ref={messagesRef} style={styles.messages}>
        {messages.map((msg, i) => (
          <MessageBubble key={i} role={msg.role} content={msg.content} agent={targetAgent} />
        ))}
      </div>

      <div style={styles.inputArea}>
        <textarea
          ref={inputRef}
          style={styles.input}
          rows={1}
          placeholder="Send a message..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = 'auto';
            el.style.height = Math.min(el.scrollHeight, 100) + 'px';
          }}
        />
        <button
          style={{ ...styles.sendBtn, ...(sending ? styles.sendBtnDisabled : {}) }}
          onClick={handleSend}
          disabled={sending}
        >
          Send
        </button>
      </div>
    </div>
  );
}

function MessageBubble({
  role,
  content,
  agent,
}: {
  role: string;
  content: string;
  agent: string;
}) {
  if (role === 'system') {
    return <div style={styles.msgSystem}>{content}</div>;
  }

  const isUser = role === 'user';

  return (
    <div style={isUser ? styles.msgUser : styles.msgAssistant}>
      {!isUser && <div style={styles.meta}>{agent}</div>}
      {isUser ? (
        content
      ) : (
        <span dangerouslySetInnerHTML={{ __html: renderContent(content) }} />
      )}
    </div>
  );
}

function escHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function renderContent(text: string): string {
  let html = escHtml(text);
  html = html.replace(/```([\s\S]*?)```/g, '<pre style="background:var(--bg-primary);padding:8px 10px;border-radius:5px;overflow-x:auto;margin:6px 0;font-size:12px;font-family:var(--font-mono)">$1</pre>');
  html = html.replace(/`([^`]+)`/g, '<code style="background:var(--bg-primary);padding:1px 4px;border-radius:3px;font-size:12px;font-family:var(--font-mono)">$1</code>');
  return html;
}

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
  },
  select: {
    background: 'var(--bg-primary)',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border)',
    padding: '4px 8px',
    borderRadius: 4,
    fontSize: 12,
  },
  chatStatus: { marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 11 },
  messages: {
    flex: 1,
    overflowY: 'auto',
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  msgUser: {
    alignSelf: 'flex-end',
    maxWidth: '75%',
    padding: '10px 14px',
    borderRadius: '10px 10px 3px 10px',
    background: 'var(--accent)',
    color: '#fff',
    lineHeight: '1.55',
    wordBreak: 'break-word',
    fontSize: 13,
  },
  msgAssistant: {
    alignSelf: 'flex-start',
    maxWidth: '75%',
    padding: '10px 14px',
    borderRadius: '10px 10px 10px 3px',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    lineHeight: '1.55',
    wordBreak: 'break-word',
    fontSize: 13,
  },
  msgSystem: {
    alignSelf: 'center',
    color: 'var(--text-tertiary)',
    fontSize: 12,
    fontStyle: 'italic',
  },
  meta: { fontSize: 10, color: 'var(--text-muted)', marginBottom: 3 },
  inputArea: {
    display: 'flex',
    padding: '10px 16px',
    background: 'var(--bg-secondary)',
    borderTop: '1px solid var(--border)',
    gap: 8,
  },
  input: {
    flex: 1,
    padding: '8px 14px',
    border: '1px solid var(--border)',
    borderRadius: 18,
    fontSize: 13,
    outline: 'none',
    resize: 'none',
    fontFamily: 'inherit',
    maxHeight: 100,
    lineHeight: '1.4',
    background: 'var(--bg-primary)',
    color: 'var(--text-secondary)',
  },
  sendBtn: {
    background: 'var(--accent)',
    color: '#fff',
    border: 'none',
    borderRadius: 18,
    padding: '8px 18px',
    fontSize: 13,
    cursor: 'pointer',
    fontWeight: 500,
  },
  sendBtnDisabled: {
    background: 'var(--bg-tertiary)',
    color: 'var(--text-muted)',
    cursor: 'not-allowed',
  },
};
