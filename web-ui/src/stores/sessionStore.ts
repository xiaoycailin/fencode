"use client";

import { create } from "zustand";
import { cleanDisplayText } from "@/lib/text";
import type { AgentEvent } from "@/types/events";
import type { Message, Session } from "@/types/session";
import type { SessionStatus } from "@/types/session";

type SessionState = {
  sessions: Session[];
  messages: Message[];
  events: AgentEvent[];
  streamingText: string;
  streamingRunId?: string;
  currentSessionTitle: string;
  currentWorkspacePath: string;
  isStreaming: boolean;
  setSessions: (sessions: Session[]) => void;
  setCurrentSessionMeta: (title: string, workspacePath: string) => void;
  hydrateSession: (messages: Message[], events: AgentEvent[], status?: SessionStatus) => void;
  addUserMessage: (message: Message) => void;
  addLocalMessage: (message: Message) => void;
  replaceLocalMessage: (id: string, patch: Partial<Message>) => void;
  failRun: (runId: string, message: string) => void;
  stopStreaming: () => void;
  applyEvents: (events: AgentEvent[]) => void;
};

export const useSessionStore = create<SessionState>((set) => ({
  sessions: [],
  messages: [],
  events: [],
  streamingText: "",
  streamingRunId: undefined,
  currentSessionTitle: "",
  currentWorkspacePath: "",
  isStreaming: false,
  setSessions: (sessions) => set({ sessions }),
  setCurrentSessionMeta: (currentSessionTitle, currentWorkspacePath) => set({ currentSessionTitle, currentWorkspacePath }),
  hydrateSession: (messages, events, status) => set(() => {
    const runState = new Map<string, "active" | "done">();
    for (const event of events) {
      if (!event.runId) continue;
      if (event.type === "session.done" || event.type === "session.error" || event.type === "message.done") runState.set(event.runId, "done");
      if (event.type === "thinking.start" || event.type === "thinking.delta" || event.type === "cmd.start") {
        if (!runState.has(event.runId)) runState.set(event.runId, "active");
      }
    }
    const activeRun = [...runState.entries()].reverse().find(([, value]) => value === "active")?.[0];
    // Trust backend status first to avoid stale "Working" state from old events.
    const isStreaming = status === "streaming" || status === "waiting-approval";
    const streamingRunId = isStreaming ? activeRun : undefined;
    return {
      messages,
      events,
      streamingText: "",
      streamingRunId,
      isStreaming,
    };
  }),
  addUserMessage: (message) => set((state) => ({
    messages: [...state.messages, message],
    streamingRunId: message.runId,
    isStreaming: true,
  })),
  addLocalMessage: (message) => set((state) => ({
    messages: [...state.messages.filter((item) => item.id !== message.id), message],
  })),
  replaceLocalMessage: (id, patch) => set((state) => ({
    messages: state.messages.map((message) => message.id === id ? { ...message, ...patch } : message),
  })),
  failRun: (runId, message) => set((state) => ({
    isStreaming: false,
    streamingRunId: undefined,
    streamingText: "",
    messages: [
      ...state.messages,
      {
        id: `local-error-${Date.now()}`,
        sessionId: state.messages.at(-1)?.sessionId ?? "",
        runId,
        role: "assistant",
        content: message,
        createdAt: new Date().toISOString(),
        status: "error",
      },
    ],
  })),
  stopStreaming: () => set({ isStreaming: false, streamingRunId: undefined, streamingText: "" }),
  applyEvents: (events) =>
    set((state) => {
      const seenEventIds = new Set(state.events.map((event) => event.id));
      const freshEvents = events.filter((event) => !seenEventIds.has(event.id));
      let streamingText = state.streamingText;
      let streamingRunId = state.streamingRunId;
      let isStreaming = state.isStreaming;
      let messages = state.messages;
      for (const event of freshEvents) {
        if (event.type === "thinking.start") {
          isStreaming = true;
          streamingRunId = event.runId ?? streamingRunId;
        }
        if (event.type === "approval.requested") {
          isStreaming = true;
          streamingRunId = event.runId ?? streamingRunId;
        }
        if (event.type === "approval.resolved") {
          isStreaming = true;
          streamingRunId = event.runId ?? streamingRunId;
        }
        if (event.type === "message.delta" && "content" in event.payload) {
          streamingRunId = event.runId ?? streamingRunId;
          streamingText += cleanDisplayText(String(event.payload.content));
        }
        if (event.type === "message.done") {
          const content = "content" in event.payload ? cleanDisplayText(String(event.payload.content)) : streamingText;
          const existingIndex = messages.findIndex((message) =>
            message.id === event.messageId || (message.role === "assistant" && message.runId === event.runId),
          );
          if (existingIndex >= 0) {
            messages = messages.map((message, index) =>
              index === existingIndex ? { ...message, content, status: "done" } : message,
            );
          } else {
            messages = [...messages, {
              id: event.id,
              sessionId: event.sessionId,
              runId: event.runId,
              role: "assistant",
              content,
              createdAt: event.timestamp,
              status: "done",
            }];
          }
          streamingText = "";
          streamingRunId = undefined;
        }
        if (event.type === "session.done" || event.type === "session.error") isStreaming = false;
      }
      return { events: [...state.events, ...freshEvents], streamingText, streamingRunId, isStreaming, messages };
    }),
}));
