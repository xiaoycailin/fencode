import test from "node:test";
import assert from "node:assert/strict";
import { buildTodoProgressAnchors } from "./todoProgressAnchors.ts";
import { initialTodoProgressState, todoProgressReducer } from "./todoProgressReducer.ts";

type Message = {
  id: string;
  sessionId: string;
  runId?: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  status: "streaming" | "done" | "error";
};

test("todo reducer transitions t=00/20/40/60 + completed", () => {
  const labels = ["Analyze request", "Run command: npm test", "Preparing final response"];
  const startAt = 1_000;
  let state = todoProgressReducer(initialTodoProgressState, {
    type: "start-run",
    runId: "run-1",
    labels,
    now: startAt,
  });

  const s00 = state.runs["run-1"];
  assert.deepEqual(s00.todos.map((todo) => todo.status), ["active", "pending", "pending"]);

  state = todoProgressReducer(state, { type: "sync-run", runId: "run-1", now: startAt + 20_000 });
  const s20 = state.runs["run-1"];
  assert.deepEqual(s20.todos.map((todo) => todo.status), ["done", "active", "pending"]);

  state = todoProgressReducer(state, { type: "sync-run", runId: "run-1", now: startAt + 40_000 });
  const s40 = state.runs["run-1"];
  assert.deepEqual(s40.todos.map((todo) => todo.status), ["done", "done", "active"]);

  state = todoProgressReducer(state, { type: "sync-run", runId: "run-1", now: startAt + 60_000 });
  const s60 = state.runs["run-1"];
  assert.deepEqual(s60.todos.map((todo) => todo.status), ["done", "done", "done"]);
  assert.equal(s60.status, "completed");
});

test("reuse same panel for same run and anchor in-place to latest user bubble", () => {
  const labels = ["Analyze request", "Run command", "Preparing final response"];
  let state = todoProgressReducer(initialTodoProgressState, {
    type: "start-run",
    runId: "run-1",
    labels,
    now: 100,
  });
  state = todoProgressReducer(state, {
    type: "start-run",
    runId: "run-1",
    labels,
    now: 120,
  });
  assert.equal(Object.keys(state.runs).length, 1);

  const messages: Message[] = [
    { id: "u1", sessionId: "s1", runId: "run-1", role: "user", content: "first", createdAt: "2026-01-01T00:00:00.000Z", status: "done" },
    { id: "u2", sessionId: "s1", runId: "run-1", role: "user", content: "latest", createdAt: "2026-01-01T00:00:10.000Z", status: "done" },
  ];
  const anchors = buildTodoProgressAnchors(messages, state);
  assert.deepEqual(anchors, { u2: "run-1" });
});

test("snapshot states", () => {
  const labels = ["Analyze request", "Use tool: web.search", "Preparing final response"];
  const startAt = 10_000;
  let state = todoProgressReducer(initialTodoProgressState, { type: "start-run", runId: "snap", labels, now: startAt });
  const at00 = state.runs.snap.todos.map((todo) => todo.status).join(",");
  state = todoProgressReducer(state, { type: "sync-run", runId: "snap", now: startAt + 20_000 });
  const at20 = state.runs.snap.todos.map((todo) => todo.status).join(",");
  state = todoProgressReducer(state, { type: "sync-run", runId: "snap", now: startAt + 40_000 });
  const at40 = state.runs.snap.todos.map((todo) => todo.status).join(",");
  state = todoProgressReducer(state, { type: "sync-run", runId: "snap", now: startAt + 60_000 });
  const at60 = state.runs.snap.todos.map((todo) => todo.status).join(",");
  const completed = state.runs.snap.status;
  assert.deepEqual({ at00, at20, at40, at60, completed }, {
    at00: "active,pending,pending",
    at20: "done,active,pending",
    at40: "done,done,active",
    at60: "done,done,done",
    completed: "completed",
  });
});

test("hydrate persisted SSE todo snapshot", () => {
  const state = todoProgressReducer(initialTodoProgressState, {
    type: "hydrate-run",
    run: {
      runId: "run-sse",
      todos: [
        { id: "a", label: "one", status: "done" },
        { id: "b", label: "two", status: "active" },
        { id: "c", label: "three", status: "pending" },
      ],
      currentIndex: 1,
      status: "running",
      startedAt: 100,
      updatedAt: 200,
      collapsed: false,
    },
  });
  assert.deepEqual(state.runs["run-sse"].todos.map((todo) => todo.status), ["done", "active", "pending"]);
});
