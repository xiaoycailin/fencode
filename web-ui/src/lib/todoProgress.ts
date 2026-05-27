import { publishEvent } from "./sse";
import type { AgentEvent } from "@/types/events";

type TodoProgressStatus = "running" | "completed" | "cancelled" | "error";
type TodoStatus = "pending" | "active" | "done";
type TodoPhase = "start" | "done";

type PersistedTodoItem = {
  id: string;
  key: string;
  label: string;
  status: TodoStatus;
  badges?: string[];
};

type PersistedTodoRun = {
  runId: string;
  todos: PersistedTodoItem[];
  currentIndex: number;
  status: TodoProgressStatus;
  updatedAt: string;
  activeCommandKey?: string;
};

type TodoDescriptor = {
  key: string;
  label: string;
  phase: TodoPhase;
  badges?: string[];
};

const MAX_TODOS = 18;

const globalTodo = globalThis as typeof globalThis & {
  __fcodeTodoRuns?: Map<string, PersistedTodoRun>;
};

function runMap() {
  globalTodo.__fcodeTodoRuns ??= new Map();
  return globalTodo.__fcodeTodoRuns;
}

export function startTodoProgress(sessionId: string, runId: string) {
  const key = todoKey(sessionId, runId);
  if (!runMap().has(key)) return;
}

export function cancelTodoProgress(sessionId: string, runId: string) {
  const next = mutateTodoRun(sessionId, runId, (run) => ({
    ...run,
    status: "cancelled",
    updatedAt: new Date().toISOString(),
    todos: run.todos.map((todo) => todo.status === "active" ? { ...todo, badges: withBadge(todo.badges, "cancelled") } : todo),
  }));
  if (next) publishTodo(sessionId, runId, next);
}

export function failTodoProgress(sessionId: string, runId: string) {
  const next = mutateTodoRun(sessionId, runId, (run) => ({
    ...run,
    status: "error",
    updatedAt: new Date().toISOString(),
    todos: run.todos.map((todo) => todo.status === "active" ? { ...todo, badges: withBadge(todo.badges, "error") } : todo),
  }));
  if (next) publishTodo(sessionId, runId, next);
}

export function syncTodoProgressFromAgentEvent(sessionId: string, event: AgentEvent) {
  const runId = event.runId;
  if (!runId || event.type === "todo.progress" || event.type === "heartbeat" || event.type === "message.delta" || event.type === "message.done") return;
  if (event.type === "session.error") {
    failTodoProgress(sessionId, runId);
    return;
  }

  if (event.type === "session.done") {
    const run = runMap().get(todoKey(sessionId, runId));
    if (!run) return;
    const completed = {
      ...run,
      todos: run.todos.map((todo) => ({ ...todo, status: "done" as const })),
      currentIndex: Math.max(0, run.todos.length - 1),
      status: "completed" as const,
      updatedAt: event.timestamp,
    };
    runMap().set(todoKey(sessionId, runId), completed);
    publishTodo(sessionId, runId, completed);
    return;
  }

  const descriptor = descriptorFromEvent(event);
  if (!descriptor) return;
  const run = ensureTodoRun(sessionId, runId, descriptor);
  if (!run) return;
  if (event.type === "cmd.done" && run.activeCommandKey) descriptor.key = run.activeCommandKey;
  const next = descriptor.phase === "start"
    ? applyStartDescriptor(run, descriptor, event.timestamp)
    : applyDoneDescriptor(run, descriptor, event.timestamp);
  runMap().set(todoKey(sessionId, runId), next);
  publishTodo(sessionId, runId, next);
}

function applyStartDescriptor(run: PersistedTodoRun, descriptor: TodoDescriptor, timestamp: string): PersistedTodoRun {
  const matchIndex = run.todos.findIndex((todo) => todo.key === descriptor.key);
  const activeIndex = run.todos.findIndex((todo) => todo.status === "active");
  const todos = run.todos.map((todo, index) => {
    if (activeIndex >= 0 && index === activeIndex && todo.key !== descriptor.key) return { ...todo, status: "done" as const };
    return todo;
  });
  if (matchIndex >= 0) {
    todos[matchIndex] = {
      ...todos[matchIndex],
      label: descriptor.label,
      status: "active",
      badges: descriptor.badges,
    };
    return {
      ...run,
      todos,
      currentIndex: matchIndex,
      status: "running",
      updatedAt: timestamp,
      activeCommandKey: descriptor.key.startsWith("cmd:") ? descriptor.key : run.activeCommandKey,
    };
  }

  const nextTodos = [...todos, {
    id: `${run.runId}-${todos.length + 1}`,
    key: descriptor.key,
    label: descriptor.label,
    status: "active" as const,
    badges: descriptor.badges,
  }];
  return {
    ...run,
    todos: trimTodos(nextTodos),
    currentIndex: nextTodos.length - 1,
    status: "running",
    updatedAt: timestamp,
    activeCommandKey: descriptor.key.startsWith("cmd:") ? descriptor.key : run.activeCommandKey,
  };
}

function applyDoneDescriptor(run: PersistedTodoRun, descriptor: TodoDescriptor, timestamp: string): PersistedTodoRun {
  const matchIndex = run.todos.findIndex((todo) => todo.key === descriptor.key);
  const activeIndex = run.todos.findIndex((todo) => todo.status === "active");
  if (matchIndex >= 0) {
    const todos = run.todos.map((todo, index) =>
      index === matchIndex
        ? { ...todo, label: descriptor.label, status: "done" as const, badges: mergeBadges(todo.badges, descriptor.badges) }
        : todo,
    );
    return {
      ...run,
      todos,
      currentIndex: matchIndex,
      updatedAt: timestamp,
      activeCommandKey: descriptor.key === run.activeCommandKey ? undefined : run.activeCommandKey,
    };
  }
  if (activeIndex >= 0) {
    const todos = run.todos.map((todo, index) =>
      index === activeIndex
        ? { ...todo, label: descriptor.label, status: "done" as const, badges: mergeBadges(todo.badges, descriptor.badges) }
        : todo,
    );
    return {
      ...run,
      todos,
      currentIndex: activeIndex,
      updatedAt: timestamp,
      activeCommandKey: descriptor.key === run.activeCommandKey ? undefined : run.activeCommandKey,
    };
  }
  const nextTodos = [...run.todos, {
    id: `${run.runId}-${run.todos.length + 1}`,
    key: descriptor.key,
    label: descriptor.label,
    status: "done" as const,
    badges: descriptor.badges,
  }];
  return {
    ...run,
    todos: trimTodos(nextTodos),
    currentIndex: nextTodos.length - 1,
    updatedAt: timestamp,
    activeCommandKey: descriptor.key === run.activeCommandKey ? undefined : run.activeCommandKey,
  };
}

function ensureTodoRun(sessionId: string, runId: string, descriptor?: TodoDescriptor | null) {
  const key = todoKey(sessionId, runId);
  const existing = runMap().get(key);
  if (existing) return existing;
  if (!descriptor) return null;
  const run = makeInitialRun(runId, descriptor);
  runMap().set(key, run);
  publishTodo(sessionId, runId, run);
  return run;
}

function mutateTodoRun(sessionId: string, runId: string, transform: (run: PersistedTodoRun) => PersistedTodoRun) {
  const run = ensureTodoRun(sessionId, runId);
  if (!run) return null;
  const next = transform(run);
  runMap().set(todoKey(sessionId, runId), next);
  return next;
}

function publishTodo(sessionId: string, runId: string, run: PersistedTodoRun) {
  publishEvent(sessionId, "todo.progress", {
    runId,
    todos: run.todos.map((todo) => ({ id: todo.id, label: todo.label, status: todo.status, badges: todo.badges })),
    currentIndex: run.currentIndex,
    status: run.status,
    updatedAt: run.updatedAt,
  }, { runId });
}

function makeInitialRun(runId: string, descriptor: TodoDescriptor): PersistedTodoRun {
  return {
    runId,
    todos: [
      { id: `${runId}-1`, key: descriptor.key, label: descriptor.label, status: descriptor.phase === "done" ? "done" : "active", badges: descriptor.badges },
    ],
    currentIndex: 0,
    status: descriptor.phase === "done" ? "completed" : "running",
    updatedAt: new Date().toISOString(),
    activeCommandKey: descriptor.key.startsWith("cmd:") && descriptor.phase === "start" ? descriptor.key : undefined,
  };
}

function descriptorFromEvent(event: AgentEvent): TodoDescriptor | null {
  const payload = event.payload as Record<string, unknown>;
  if (event.type === "cmd.start") return { key: `cmd:${String(payload.command ?? "shell")}`, label: `Run command: ${String(payload.command ?? "shell command")}`, phase: "start" };
  if (event.type === "cmd.done") return { key: `cmd:${String(payload.pid ?? "shell")}`, label: commandDoneLabel(payload), phase: "done", badges: commandBadges(payload) };
  if (event.type === "tool.start") return { key: `tool:${String(payload.tool ?? "tool")}`, label: `Use tool: ${String(payload.tool ?? "tool")}`, phase: "start", badges: badgesFromTool(payload) };
  if (event.type === "tool.done") return { key: `tool:${String(payload.tool ?? "tool")}`, label: `Tool finished: ${String(payload.tool ?? "tool")}`, phase: "done", badges: badgesFromTool(payload) };
  if (event.type === "tool.error") return { key: `tool:${String(payload.tool ?? "tool")}`, label: `Tool failed: ${String(payload.tool ?? "tool")}`, phase: "done", badges: withBadge(badgesFromTool(payload), "error") };
  if (event.type.startsWith("file.")) return { key: `file:${String(payload.path ?? payload.newPath ?? event.type)}`, label: `Update file: ${String(payload.path ?? payload.newPath ?? "workspace file")}`, phase: "done", badges: [event.type.replace("file.", "")] };
  if (event.type === "web.search.start") return { key: `search:${String(payload.query ?? "search")}`, label: `Search web: ${String(payload.query ?? "search")}`, phase: "start" };
  if (event.type === "web.search.done") return { key: `search:${String(payload.query ?? "search")}`, label: "Search complete", phase: "done" };
  if (event.type === "git.operation") return { key: `git:${String(payload.operation ?? "operation")}`, label: `Git: ${String(payload.operation ?? "operation")}`, phase: "done", badges: ["git"] };
  if (event.type === "mcp.call") return { key: `mcp:${String(payload.tool ?? "mcp")}`, label: `MCP: ${String(payload.tool ?? "call")}`, phase: "done", badges: ["mcp"] };
  if (event.type === "permission.request") return { key: `permission:${String(payload.id ?? "request")}`, label: `Waiting permission: ${String(payload.action ?? "action")}`, phase: "start", badges: [String(payload.risk ?? "medium")] };
  if (event.type === "permission.response") return { key: `permission:${String(payload.id ?? "request")}`, label: "Permission resolved", phase: "done" };
  return null;
}

function badgesFromTool(payload: Record<string, unknown>) {
  const badges: string[] = [];
  const tool = String(payload.tool ?? "");
  if (tool === "system.self-heal") badges.push("retry");
  if (tool === "context.compact") badges.push("compact");
  const status = String(payload.status ?? "");
  if (status === "recovered") badges.push("recovered");
  return badges.length ? badges : undefined;
}

function trimTodos(todos: PersistedTodoItem[]) {
  if (todos.length <= MAX_TODOS) return todos;
  return todos.slice(todos.length - MAX_TODOS);
}

function mergeBadges(left?: string[], right?: string[]) {
  return [...new Set([...(left ?? []), ...(right ?? [])])];
}

function withBadge(badges: string[] | undefined, badge: string) {
  return mergeBadges(badges, [badge]);
}

function commandDoneLabel(payload: Record<string, unknown>) {
  const exitCode = Number(payload.exitCode ?? 0);
  return exitCode === 0 ? "Command finished" : `Command failed (${exitCode})`;
}

function commandBadges(payload: Record<string, unknown>) {
  const exitCode = Number(payload.exitCode ?? 0);
  return exitCode === 0 ? ["exit 0"] : [`exit ${exitCode}`];
}

function todoKey(sessionId: string, runId: string) {
  return `${sessionId}:${runId}`;
}
