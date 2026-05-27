"use client";

import { useEffect, useRef } from "react";
import type { AgentEvent } from "@/types/events";

type UseAgentStreamOptions = {
  sessionId: string;
  onEvents: (events: AgentEvent[]) => void;
};

const DELTA_TYPES = new Set(["message.delta", "thinking.delta"]);

export function useAgentStream({ sessionId, onEvents }: UseAgentStreamOptions) {
  const lastEventIdRef = useRef<string | null>(null);
  const pendingRef = useRef<AgentEvent[]>([]);
  const flushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamLastSeenAtRef = useRef<number>(0);
  const reconnectRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let closed = false;
    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let staleTimer: ReturnType<typeof setInterval> | null = null;
    let polling = false;
    streamLastSeenAtRef.current = Date.now();

    function flush() {
      const batch = pendingRef.current;
      pendingRef.current = [];
      flushRef.current = null;
      if (batch.length) onEvents(batch);
    }

    function enqueue(event: AgentEvent) {
      streamLastSeenAtRef.current = Date.now();
      if (DELTA_TYPES.has(event.type)) {
        if (flushRef.current) {
          clearTimeout(flushRef.current);
          flushRef.current = null;
        }
        pendingRef.current.push(event);
        flush();
        return;
      }
      pendingRef.current.push(event);
      if (!flushRef.current) flushRef.current = setTimeout(flush, 50);
    }

    async function pollMissedEvents() {
      if (polling || closed) return;
      polling = true;
      try {
        const query = lastEventIdRef.current
          ? `?lastEventId=${encodeURIComponent(lastEventIdRef.current)}`
          : "";
        const response = await fetch(`/api/sessions/${sessionId}/events${query}`, { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json() as { data?: AgentEvent[] };
        const events = Array.isArray(payload.data) ? payload.data : [];
        if (!events.length) return;
        for (const event of events) {
          lastEventIdRef.current = event.id;
          enqueue(event);
        }
      } catch {
        // ignore fetch error
      } finally {
        polling = false;
      }
    }

    function connect() {
      if (closed) return;
      const url = lastEventIdRef.current
        ? `/api/sessions/${sessionId}/stream?lastEventId=${encodeURIComponent(lastEventIdRef.current)}`
        : `/api/sessions/${sessionId}/stream`;
      source = new EventSource(url);
      source.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as AgentEvent;
          lastEventIdRef.current = event.id;
          enqueue(event);
        } catch {
          // ignore parse error
        }
      };
      source.onerror = () => {
        source?.close();
        if (!closed) window.setTimeout(connect, 900);
      };
    }
    reconnectRef.current = () => {
      source?.close();
      if (!closed) connect();
    };

    connect();
    pollTimer = setInterval(() => {
      void pollMissedEvents();
    }, 3000);
    staleTimer = setInterval(() => {
      const staleMs = Date.now() - streamLastSeenAtRef.current;
      if (staleMs > 12_000) reconnectRef.current();
    }, 4000);

    return () => {
      closed = true;
      source?.close();
       if (pollTimer) clearInterval(pollTimer);
      if (staleTimer) clearInterval(staleTimer);
      if (flushRef.current) clearTimeout(flushRef.current);
    };
  }, [onEvents, sessionId]);
}
