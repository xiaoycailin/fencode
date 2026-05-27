export type TodoStatus = "pending" | "active" | "done";
export type TodoRunStatus = "running" | "completed" | "cancelled" | "error";

export type TodoItem = {
  id: string;
  label: string;
  status: TodoStatus;
  badges?: string[];
};

export type TodoProgressRun = {
  runId: string;
  todos: TodoItem[];
  currentIndex: number;
  status: TodoRunStatus;
  startedAt: number;
  updatedAt: number;
  collapsed: boolean;
};

export type TodoProgressState = {
  runs: Record<string, TodoProgressRun>;
};

export type TodoProgressAction =
  | { type: "start-run"; runId: string; labels: string[]; now: number }
  | { type: "sync-run"; runId: string; now: number }
  | { type: "hydrate-run"; run: TodoProgressRun }
  | { type: "toggle-collapse"; runId: string }
  | { type: "set-failed"; runId: string; now: number }
  | { type: "set-cancelled"; runId: string; now: number };

export const TODO_STEP_MS = 20_000;

export const initialTodoProgressState: TodoProgressState = {
  runs: {},
};

export function createDemoTodoLabels() {
  return [
    "Scan workspace and session context",
    "Execute tools and collect outputs",
    "Finalize answer and verify changes",
  ];
}

export function todoProgressReducer(state: TodoProgressState, action: TodoProgressAction): TodoProgressState {
  if (action.type === "start-run") {
    const existing = state.runs[action.runId];
    if (existing) return state;
    const todos = action.labels.map((label, index) => ({
      id: `${action.runId}-${index + 1}`,
      label,
      status: index === 0 ? "active" : "pending",
    } satisfies TodoItem));
    return {
      ...state,
      runs: {
        ...state.runs,
        [action.runId]: {
          runId: action.runId,
          todos,
          currentIndex: 0,
          status: "running",
          startedAt: action.now,
          updatedAt: action.now,
          collapsed: false,
        },
      },
    };
  }

  if (action.type === "toggle-collapse") {
    const run = state.runs[action.runId];
    if (!run) return state;
    return {
      ...state,
      runs: {
        ...state.runs,
        [action.runId]: { ...run, collapsed: !run.collapsed },
      },
    };
  }

  if (action.type === "hydrate-run") {
    const existing = state.runs[action.run.runId];
    return {
      ...state,
      runs: {
        ...state.runs,
        [action.run.runId]: {
          ...action.run,
          collapsed: existing?.collapsed ?? action.run.collapsed,
        },
      },
    };
  }

  if (action.type === "sync-run") {
    const run = state.runs[action.runId];
    if (!run || run.status !== "running") return state;
    const steps = Math.max(0, Math.floor((action.now - run.startedAt) / TODO_STEP_MS));
    const doneCount = Math.min(run.todos.length, steps);
    const nextIndex = doneCount >= run.todos.length ? run.todos.length - 1 : doneCount;
    const nextStatus: TodoRunStatus = doneCount >= run.todos.length ? "completed" : "running";
    const todos = run.todos.map((todo, index) => {
      if (index < doneCount) return { ...todo, status: "done" as const };
      if (index === nextIndex && nextStatus === "running") return { ...todo, status: "active" as const };
      if (index === run.todos.length - 1 && nextStatus === "completed") return { ...todo, status: "done" as const };
      return { ...todo, status: "pending" as const };
    });
    if (run.currentIndex === nextIndex && run.status === nextStatus && todosEqual(run.todos, todos)) return state;
    return {
      ...state,
      runs: {
        ...state.runs,
        [action.runId]: {
          ...run,
          todos,
          currentIndex: nextIndex,
          status: nextStatus,
          updatedAt: action.now,
        },
      },
    };
  }

  if (action.type === "set-failed" || action.type === "set-cancelled") {
    const run = state.runs[action.runId];
    if (!run) return state;
    return {
      ...state,
      runs: {
        ...state.runs,
        [action.runId]: {
          ...run,
          status: action.type === "set-failed" ? "error" : "cancelled",
          updatedAt: action.now,
        },
      },
    };
  }
  return state;
}

function todosEqual(left: TodoItem[], right: TodoItem[]) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index].status !== right[index].status) return false;
  }
  return true;
}
