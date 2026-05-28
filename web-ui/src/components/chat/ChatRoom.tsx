"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { useState } from "react";
import { ChevronDown, Copy, MessageSquarePlus, Quote } from "lucide-react";
import { ActivityFeed } from "./ActivityFeed";
import { ChatInput, type GitChangeSummary } from "./ChatInput";
import { EditedFilesSummary } from "./EditedFilesSummary";
import { MarkdownMessage } from "./MarkdownMessage";
import { TodoProgressPanel } from "./todoProgress/TodoProgressPanel";
import { buildTodoProgressAnchors } from "./todoProgress/todoProgressAnchors";
import { initialTodoProgressState, todoProgressReducer, type TodoProgressRun } from "./todoProgress/todoProgressReducer";
import { useAgentStream } from "@/hooks/useAgentStream";
import { useSessionStore } from "@/stores/sessionStore";
import type { AgentInputItem } from "@/types/agentInput";
import type { AgentEvent } from "@/types/events";
import type { Message, SessionDetail } from "@/types/session";
import type { ModelConfig, WorkspaceConfig } from "@/lib/db";

export function ChatRoom({ detail }: { detail: SessionDetail }) {
  const { messages, events, streamingText, streamingRunId, isStreaming, hydrateSession, applyEvents, addUserMessage, addLocalMessage, replaceLocalMessage, failRun, stopStreaming, setCurrentSessionMeta } = useSessionStore();
  const [session, setSession] = useState(detail.session);
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceConfig[]>([]);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [contextChips, setContextChips] = useState<Array<{ id: string; text: string }>>([]);
  const [selectionMenu, setSelectionMenu] = useState<{ text: string; x: number; y: number } | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [authBadge, setAuthBadge] = useState<{ mode: string; refreshError?: string | null } | null>(null);
  const [todoProgress, dispatchTodoProgress] = useReducer(todoProgressReducer, initialTodoProgressState);
  const handledTodoEventIdsRef = useRef<Set<string>>(new Set());
  const todoCollapsedRef = useRef<Record<string, boolean>>({});
  const endRef = useRef<HTMLDivElement | null>(null);
  const chatColumnRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const showJumpToBottomRef = useRef(false);
  const hasInitialAutoScrollRef = useRef(false);
  const pendingInitialAutoScrollRef = useRef(false);
  const onEvents = useCallback((batch: Parameters<typeof applyEvents>[0]) => {
    applyEvents(batch);
  }, [applyEvents]);
  const getScrollContainer = useCallback(() => {
    if (scrollContainerRef.current) return scrollContainerRef.current;
    const container = document.querySelector(".content-area") as HTMLElement | null;
    scrollContainerRef.current = container;
    return container;
  }, []);
  const updateScrollState = useCallback(() => {
    const container = getScrollContainer();
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - (container.scrollTop + container.clientHeight);
    const next = distanceFromBottom > 220;
    if (showJumpToBottomRef.current !== next) {
      showJumpToBottomRef.current = next;
      setShowJumpToBottom(next);
    }
  }, [getScrollContainer]);
  const scheduleScrollStateUpdate = useCallback(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      updateScrollState();
    });
  }, [updateScrollState]);
  const scrollToBottom = useCallback((smooth = false) => {
    const container = getScrollContainer();
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    scheduleScrollStateUpdate();
  }, [getScrollContainer, scheduleScrollStateUpdate]);

  useEffect(() => {
    hydrateSession(detail.messages, detail.events, detail.session.status);
    setSession(detail.session);
  }, [detail.events, detail.messages, detail.session, detail.session.status, hydrateSession]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("fcode:last-model", session.model);
    window.localStorage.setItem("fcode:last-workspace", session.workspacePath);
    window.localStorage.setItem("fcode:last-permission", session.permission);
    setCurrentSessionMeta(session.title, session.workspacePath);
  }, [session.model, session.permission, session.title, session.workspacePath, setCurrentSessionMeta]);

  useEffect(() => {
    void fetch("/api/settings/models").then((response) => response.json()).then((data) => setModels(data.data ?? []));
    void fetch("/api/settings/workspaces").then((response) => response.json()).then((data) => setWorkspaces(data.data ?? []));
    void fetch("/api/settings/auth").then((response) => response.json()).then((data) => {
      const mode = data?.detected?.mode ?? "unknown";
      const refreshError = data?.detected?.refreshError ?? null;
      setAuthBadge({ mode, refreshError });
    });
  }, []);

  useEffect(() => {
    updateScrollState();
    const container = getScrollContainer();
    if (!container) return;
    container.addEventListener("scroll", scheduleScrollStateUpdate, { passive: true });
    return () => {
      container.removeEventListener("scroll", scheduleScrollStateUpdate);
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, [getScrollContainer, scheduleScrollStateUpdate, updateScrollState]);

  useEffect(() => {
    if (!pendingInitialAutoScrollRef.current || !endRef.current) return;
    scrollToBottom();
    pendingInitialAutoScrollRef.current = false;
    hasInitialAutoScrollRef.current = true;
    window.setTimeout(updateScrollState, 120);
  }, [messages, events, streamingText, scrollToBottom, updateScrollState]);

  useEffect(() => {
    if (isStreaming && !hasInitialAutoScrollRef.current) {
      pendingInitialAutoScrollRef.current = true;
    }
  }, [isStreaming]);

  useEffect(() => {
    function handleSelection() {
      const selection = window.getSelection();
      const text = selection?.toString().trim() ?? "";
      if (!text || !selection || selection.rangeCount === 0) {
        setSelectionMenu(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const container = range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
      if (!container?.closest(".message.assistant")) {
        setSelectionMenu(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      setSelectionMenu({ text, x: rect.left + rect.width / 2, y: rect.top - 12 });
    }
    document.addEventListener("selectionchange", handleSelection);
    return () => document.removeEventListener("selectionchange", handleSelection);
  }, []);

  useAgentStream({ sessionId: detail.session.id, onEvents });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(`fcode:todo:collapsed:${detail.session.id}`);
      todoCollapsedRef.current = raw ? JSON.parse(raw) as Record<string, boolean> : {};
    } catch {
      todoCollapsedRef.current = {};
    }
  }, [detail.session.id]);

  useEffect(() => {
    for (const event of events) {
      if (handledTodoEventIdsRef.current.has(event.id)) continue;
      handledTodoEventIdsRef.current.add(event.id);
      const run = parseTodoRunFromEvent(event);
      if (run) {
        run.collapsed = todoCollapsedRef.current[run.runId] ?? run.collapsed;
        dispatchTodoProgress({ type: "hydrate-run", run });
      }
      if (event.type === "session.error" && event.runId) dispatchTodoProgress({ type: "set-failed", runId: event.runId, now: Date.now() });
      if (event.type === "session.done" && event.runId) dispatchTodoProgress({ type: "sync-run", runId: event.runId, now: Date.now() + 60_000 });
    }
  }, [events]);

  function toggleTodoCollapse(runId: string) {
    const next = { ...todoCollapsedRef.current, [runId]: !(todoCollapsedRef.current[runId] ?? false) };
    todoCollapsedRef.current = next;
    if (typeof window !== "undefined") {
      window.localStorage.setItem(`fcode:todo:collapsed:${detail.session.id}`, JSON.stringify(next));
    }
    dispatchTodoProgress({ type: "toggle-collapse", runId });
  }

  async function send(text: string, input: AgentInputItem[]) {
    if (!hasInitialAutoScrollRef.current) pendingInitialAutoScrollRef.current = true;
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const nextTitle = text.trim().slice(0, 64) || session.title;
    if (session.title === "New chat" || session.title === "FCode V2 SSE demo") {
      setSession((current) => ({ ...current, title: nextTitle }));
    }
    const optimistic: Message = {
      id: `optimistic-${Date.now()}`,
      sessionId: detail.session.id,
      runId,
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
      status: "done",
    };
    addUserMessage(optimistic);
    const response = await fetch(`/api/sessions/${detail.session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text, runId, input }),
    });
    if (!response.ok) {
      failRun(runId, `Failed to send message (${response.status})`);
      return;
    }
    window.dispatchEvent(new Event("fcode:sessions-refresh"));
  }

  async function patchSession(patch: Partial<Pick<typeof session, "model" | "workspacePath" | "permission">>) {
    setSession((current) => ({ ...current, ...patch }));
    await fetch(`/api/sessions/${detail.session.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  }

  async function interruptSession() {
    if (streamingRunId) dispatchTodoProgress({ type: "set-cancelled", runId: streamingRunId, now: Date.now() });
    await fetch(`/api/sessions/${detail.session.id}/interrupt`, { method: "POST" });
    stopStreaming();
  }

  async function resolveApproval(decision: "approved" | "rejected") {
    const response = await fetch(`/api/sessions/${detail.session.id}/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const message = typeof payload?.error?.message === "string"
        ? payload.error.message
        : `Approval request failed (${response.status})`;
      addLocalMessage({
        id: `approval-error-${Date.now()}`,
        sessionId: detail.session.id,
        role: "system",
        content: message,
        createdAt: new Date().toISOString(),
        status: "error",
      });
    }
  }

  async function compactSession() {
    if (compacting || isStreaming) return;
    const markerId = `compact-${Date.now()}`;
    setCompacting(true);
    addLocalMessage({
      id: markerId,
      sessionId: detail.session.id,
      role: "system",
      content: "Compacting context...",
      createdAt: new Date().toISOString(),
      status: "streaming",
    });
    try {
      const response = await fetch(`/api/sessions/${detail.session.id}/compact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "manual" }),
      });
      const data = await response.json();
      if (response.ok) {
        if (data.session) setSession(data.session);
        replaceLocalMessage(markerId, { content: "Context compacted", status: "done" });
        window.dispatchEvent(new Event("fcode:sessions-refresh"));
      } else {
        replaceLocalMessage(markerId, { content: "Context compact failed", status: "error" });
      }
    } finally {
      setCompacting(false);
    }
  }

  const modelContextWindow = models.find((model) => model.id === session.model)?.contextWindow ?? session.contextWindow ?? 128000;
  const orderedMessages = useMemo(
    () => [...messages].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    [messages],
  );
  const sessionView = useMemo(() => {
    const latestCompactMarker = [...messages]
      .reverse()
      .find((message) => message.role === "system" && /context compacted/i.test(message.content));
    const compactedMessages = latestCompactMarker
      ? messages.filter((message) => message.createdAt >= latestCompactMarker.createdAt)
      : messages;
    const compactedEvents = latestCompactMarker
      ? events.filter((event) => event.timestamp >= latestCompactMarker.createdAt)
      : events;
    const derivedJoined = [
      session.compactSummary ?? "",
      ...compactedMessages.map((message) => `${message.role}: ${message.content}`),
      ...compactedEvents.slice(-320).map((event) => `${event.type} ${JSON.stringify(event.payload)}`),
      streamingText ? `assistant: ${streamingText}` : "",
    ].filter(Boolean).join("\n");
    const derivedUsageTokens = Math.max(0, Math.ceil(derivedJoined.length / 4));
    const derivedUsagePct = Math.max(0, Math.min(100, Math.round((derivedUsageTokens / modelContextWindow) * 100)));
    return {
      ...session,
      contextWindow: modelContextWindow,
      contextUsageTokens: derivedUsageTokens,
      contextUsagePct: derivedUsagePct,
    };
  }, [events, messages, modelContextWindow, session, streamingText]);
  const eventsByRun = useMemo(() => {
    const byRun = new Map<string, typeof events>();
    for (const event of events) {
      if (!event.runId || event.type === "message.delta" || event.type === "message.done" || event.type === "heartbeat") continue;
      byRun.set(event.runId, [...(byRun.get(event.runId) ?? []), event]);
    }
    return byRun;
  }, [events]);
  const assistantByRun = useMemo(() => {
    const byRun = new Map<string, Message>();
    for (const message of messages) {
      if (message.role === "assistant" && message.runId && message.content.trim()) {
        byRun.set(message.runId, message);
      }
    }
    return byRun;
  }, [messages]);
  const orphanAssistantMessages = useMemo(
    () => orderedMessages.filter((message) => message.role === "assistant" && message.content.trim() && !message.runId),
    [orderedMessages],
  );
  const handledAssistantIds = useMemo(() => {
    const handled = new Set<string>();
    for (const message of orderedMessages) {
      if (message.role !== "user" || !message.runId) continue;
      const assistant = assistantByRun.get(message.runId);
      if (assistant) handled.add(assistant.id);
    }
    return handled;
  }, [assistantByRun, orderedMessages]);
  const orphanRunIds = useMemo(() => {
    const streamedRunIds = new Set([...eventsByRun.keys(), ...assistantByRun.keys()]);
    const userRunIds = new Set(orderedMessages.filter((message) => message.role === "user").map((message) => message.runId).filter(Boolean));
    return [...streamedRunIds].filter((runId) => {
      if (userRunIds.has(runId)) return false;
      const runEvents = eventsByRun.get(runId) ?? [];
      return !runEvents.length || !runEvents.every(isCompactContextEvent);
    });
  }, [assistantByRun, eventsByRun, orderedMessages]);
  const orphanRunsOrdered = useMemo(() => {
    return orphanRunIds
      .map((runId) => {
        const runEvents = eventsByRun.get(runId) ?? [];
        const assistant = assistantByRun.get(runId);
        const timestamps = [
          ...runEvents.map((event) => event.timestamp),
          assistant?.createdAt ?? "",
        ].filter(Boolean);
        return {
          runId,
          sortTs: timestamps.length ? timestamps.sort()[0] : "9999-12-31T23:59:59.999Z",
        };
      })
      .sort((left, right) => left.sortTs.localeCompare(right.sortTs));
  }, [assistantByRun, eventsByRun, orphanRunIds]);
  const todoAnchors = useMemo(() => buildTodoProgressAnchors(orderedMessages, todoProgress), [orderedMessages, todoProgress]);
  const activeEditSummary = buildActiveEditSummary(
    isStreaming && streamingRunId ? eventsByRun.get(streamingRunId) ?? [] : [],
  );

  return (
    <div className="chat-layout">
      <div className="chat-main">
        {showJumpToBottom ? (
          <button
            className="jump-bottom-button"
            onClick={() => scrollToBottom(true)}
            aria-label="Scroll to bottom"
          >
            <ChevronDown size={15} />
            <span>Bottom</span>
          </button>
        ) : null}
        <div className="chat-column" ref={chatColumnRef}>
          {authBadge ? (
            <div className="chat-start-spacer" style={{ paddingTop: 10, paddingBottom: 2 }}>
              <span className="context-chip" style={{ marginRight: 8 }}>
                <span>Auth: {authBadge.mode === "oauth" ? "OAuth" : authBadge.mode === "api-key" ? "API Key" : "Unknown"}</span>
              </span>
              {authBadge.refreshError ? (
                <span className="context-chip">
                  <span>Refresh: Failed</span>
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="chat-start-spacer" />
          <div className="message-list">
            {orderedMessages.map((message) => {
              if (message.role === "system") {
                return <CompactDivider key={message.id} label={message.content} loading={message.status === "streaming"} error={message.status === "error"} />;
              }
              if (message.role === "assistant") {
                if (!message.content.trim() || message.runId) return null;
                return (
                  <article key={message.id} className="message assistant">
                    <MarkdownMessage text={message.content} />
                  </article>
                );
              }
              const runId = message.runId;
              const todoRunId = todoAnchors[message.id];
              const runEvents = runId ? eventsByRun.get(runId) ?? [] : [];
              const assistant = runId ? assistantByRun.get(runId) : undefined;
              const isRunActive = Boolean(isStreaming && streamingRunId === runId);
              const hideAssistantNarration = Boolean(runId && todoProgress.runs[runId] && assistant && isTodoNarrationMessage(assistant.content));
              return (
                <div key={message.id} className="message-group">
                  <article className={`message ${message.role}`}>
                    <MarkdownMessage text={message.content} />
                  </article>
                  {todoRunId ? (
                    <TodoProgressPanel
                      run={todoProgress.runs[todoRunId]}
                      onToggleCollapse={() => toggleTodoCollapse(todoRunId)}
                    />
                  ) : null}
                  {runEvents.length ? <ActivityFeed events={runEvents} active={isRunActive} onApprovalDecision={resolveApproval} /> : null}
                  {assistant && !hideAssistantNarration ? (
                    <article className="message assistant">
                      <MarkdownMessage text={assistant.content} />
                    </article>
                  ) : null}
                  {runEvents.some((event) => event.type === "file.edit") ? (
                    <EditedFilesSummary events={runEvents} workspacePath={session.workspacePath} sessionId={detail.session.id} runId={runId} />
                  ) : null}
                  {isRunActive && streamingText ? (
                    <article className="message assistant">
                      <MarkdownMessage text={streamingText} />
                    </article>
                  ) : null}
                </div>
              );
            })}
            {orphanAssistantMessages.map((message) => (
              <article key={message.id} className="message assistant" style={{ display: handledAssistantIds.has(message.id) ? "none" : undefined }}>
                {isTodoNarrationMessage(message.content) ? null : <MarkdownMessage text={message.content} />}
              </article>
            ))}
            {orphanRunsOrdered.map(({ runId }) => (
              <div key={runId} className="message-group">
                <ActivityFeed events={eventsByRun.get(runId) ?? []} active={isStreaming && streamingRunId === runId} onApprovalDecision={resolveApproval} />
                {assistantByRun.get(runId)?.content ? (
                  <article className="message assistant">
                    <MarkdownMessage text={assistantByRun.get(runId)!.content} />
                  </article>
                ) : null}
                {(eventsByRun.get(runId) ?? []).some((event) => event.type === "file.edit") ? (
                  <EditedFilesSummary events={eventsByRun.get(runId) ?? []} workspacePath={session.workspacePath} sessionId={detail.session.id} runId={runId} />
                ) : null}
              </div>
            ))}
            <div ref={endRef} />
          </div>
        </div>
        <ChatInput
          disabled={isStreaming}
          activeEditSummary={activeEditSummary}
          session={sessionView}
          models={models}
          workspaces={workspaces}
          text={draftText}
          onTextChange={setDraftText}
          contextChips={contextChips}
          onRemoveContext={(id) => setContextChips((current) => current.filter((chip) => chip.id !== id))}
          onPatchSession={patchSession}
          onSend={send}
          onStop={interruptSession}
          onCompact={compactSession}
          compacting={compacting}
        />
        {selectionMenu ? (
          <div className="selection-toolbar" style={{ left: selectionMenu.x, top: selectionMenu.y }}>
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                setDraftText((current) => current ? `${current}\n\nAsk about this selection:\n${selectionMenu.text}` : `Ask about this selection:\n${selectionMenu.text}`);
                setSelectionMenu(null);
              }}
            >
              <MessageSquarePlus size={12} />
              Ask
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                setContextChips((current) => [...current, { id: `${Date.now()}-${current.length}`, text: selectionMenu.text }]);
                setSelectionMenu(null);
              }}
            >
              <Quote size={12} />
              Use as context
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={async () => {
                await navigator.clipboard.writeText(selectionMenu.text);
                setSelectionMenu(null);
              }}
            >
              <Copy size={12} />
              Copy
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function isCompactContextEvent(event: { type: string; payload: unknown }) {
  const payload = event.payload as { tool?: string } | undefined;
  return event.type.startsWith("tool.") && payload?.tool === "context.compact";
}

function buildActiveEditSummary(events: AgentEvent[]): GitChangeSummary | null {
  const editEvents = events.filter((event) => event.type === "file.edit");
  if (!editEvents.length) return null;
  const files = new Map<string, { path: string }>();
  let additions = 0;
  let deletions = 0;
  for (const event of editEvents) {
    const payload = event.payload as { path?: string; additions?: number; deletions?: number };
    const path = String(payload.path ?? "").trim();
    if (path) files.set(path, { path });
    additions += Number(payload.additions) || 0;
    deletions += Number(payload.deletions) || 0;
  }
  return {
    changedFiles: files.size || editEvents.length,
    additions,
    deletions,
    files: [...files.values()],
  };
}

function parseTodoRunFromEvent(event: AgentEvent): TodoProgressRun | null {
  if (event.type !== "todo.progress") return null;
  const payload = event.payload as {
    runId?: string;
    todos?: Array<{ id?: string; label?: string; status?: "pending" | "active" | "done"; badges?: string[] }>;
    currentIndex?: number;
    status?: "running" | "completed" | "cancelled" | "error";
    updatedAt?: string;
  };
  if (!payload.runId || !Array.isArray(payload.todos) || !payload.todos.length) return null;
  const updatedAt = payload.updatedAt ? Date.parse(payload.updatedAt) : Date.now();
  const safeUpdatedAt = Number.isFinite(updatedAt) ? updatedAt : Date.now();
  return {
    runId: payload.runId,
    todos: payload.todos.map((todo, index) => ({
      id: todo.id || `${payload.runId}-${index + 1}`,
      label: todo.label || `Todo ${index + 1}`,
      status: todo.status || "pending",
      badges: todo.badges,
    })),
    currentIndex: Math.max(0, Number(payload.currentIndex ?? 0)),
    status: payload.status || "running",
    startedAt: safeUpdatedAt,
    updatedAt: safeUpdatedAt,
    collapsed: false,
  };
}

function isTodoNarrationMessage(content: string) {
  const text = content.toLowerCase();
  return text.includes("live progress") && text.includes("todo 1") && text.includes("todo 2") ||
    text.includes("todo progress") && text.includes("[~]") ||
    text.includes("update:") && text.includes("final:") && text.includes("todo");
}

function CompactDivider({ label, loading, error }: { label: string; loading: boolean; error: boolean }) {
  return (
    <div className={`compact-divider${loading ? " loading" : ""}${error ? " error" : ""}`}>
      <span />
      <strong>{label}</strong>
      <span />
    </div>
  );
}

