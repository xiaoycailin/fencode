"use client";

import { ChevronDown, CircleDashed, LoaderCircle, SquareCheckBig } from "lucide-react";
import type { TodoProgressRun } from "./todoProgressReducer";

export function TodoProgressPanel({
  run,
  sticky = true,
  onToggleCollapse,
}: {
  run: TodoProgressRun;
  sticky?: boolean;
  onToggleCollapse: () => void;
}) {
  const isDone = run.status === "completed";
  const summary = isDone
    ? "Completed"
    : run.status === "error"
      ? "Error"
      : run.status === "cancelled"
        ? "Cancelled"
        : `Step ${Math.min(run.currentIndex + 1, run.todos.length)} of ${run.todos.length}`;
  return (
    <section
      className={`todo-progress-panel${sticky ? " sticky" : ""}${run.collapsed ? " collapsed" : ""}`}
      data-testid={`todo-progress-${run.runId}`}
      data-run-id={run.runId}
      aria-live="polite"
    >
      <div className="todo-progress-header">
        <div className="todo-progress-headline">
          <span className={`todo-progress-dot status-${run.status}`} aria-hidden="true" />
          <strong>Todo Progress</strong>
          <span className="todo-progress-status">{summary}</span>
        </div>
        <button
          type="button"
          className="todo-progress-toggle"
          onClick={onToggleCollapse}
          aria-label={run.collapsed ? "Expand todo progress" : "Collapse todo progress"}
          aria-expanded={!run.collapsed}
        >
          <ChevronDown size={14} />
        </button>
      </div>
      <div className={`todo-progress-body${run.collapsed ? " hidden" : ""}`}>
        {run.todos.map((todo) => (
          <div key={todo.id} className={`todo-progress-row state-${todo.status}`}>
            <span className="todo-progress-icon" aria-hidden="true">
              {todo.status === "done" ? <SquareCheckBig size={14} /> : todo.status === "active" ? <LoaderCircle size={14} className="spin" /> : <CircleDashed size={14} />}
            </span>
            <span className="todo-progress-bracket" aria-hidden="true">
              {todo.status === "done" ? "[x]" : todo.status === "active" ? "[~]" : "[ ]"}
            </span>
            <span className="todo-progress-label">
              <span>{todo.label}</span>
              {todo.badges?.length ? (
                <span className="todo-progress-badges">
                  {todo.badges.map((badge) => <em key={badge}>{badge}</em>)}
                </span>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
