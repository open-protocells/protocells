import { useEffect, useRef, useState, useCallback } from 'react';

interface Message {
  role: string;
  content: string;
  timestamp: number;
}

export function useSSE(sessionId: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const connect = useCallback(() => {
    esRef.current?.close();

    const es = new EventSource(`/api/events?session=${sessionId}`);
    esRef.current = es;

    es.addEventListener('message', (e) => {
      const msg: Message = JSON.parse(e.data);
      setMessages((prev) => {
        // Deduplicate by timestamp + role
        if (prev.some((m) => m.timestamp === msg.timestamp && m.role === msg.role)) {
          return prev;
        }
        return [...prev, msg];
      });
    });

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
  }, [sessionId]);

  useEffect(() => {
    connect();
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, [connect]);

  const clearMessages = useCallback(() => setMessages([]), []);

  return { messages, connected, reconnect: connect, clearMessages };
}
