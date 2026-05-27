import http from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeSse, publishEvent, replayEvents, sessionBus } from "./events.js";
import { executeAgentRuntime } from "./agentRuntime.js";
import { gitCommit, gitDiff, gitStage, gitStatus } from "./git.js";
import { makeId, nowIso } from "./id.js";
import {
  addMessage,
  createSession,
  deleteSession,
  engineHomePath,
  engineWorkspacePath,
  getSessionDetail,
  listMessages,
  listSessions,
  patchSession,
} from "./store.js";
import { INTERRUPT_MESSAGE } from "./runtime/runtimePolicy.js";
import { ERROR_CODES, errorPayload } from "./runtime/toolError.js";
import { runImagegenSkillIfAny } from "./runtime/imagegenSkill.js";
import { forceRefreshOauthToken, resolveProviderAuth } from "./runtime/authResolver.js";
import { deletePath, readTextFile, readTree, writeTextFile } from "./workspace.js";
import type { Message } from "./types.js";
import { AGENT_RUN_TIMEOUT_MS } from "./runtime/runtimePolicy.js";
import { resolveFencodeHome } from "./runtimeHome.js";

type JsonBody = Record<string, unknown>;
type ActiveRun = { runId: string; controller: AbortController };
type PendingApproval = {
  runId: string;
  request: { type: "command"; command: string; reason: string; hint: string };
  resolve: (decision: "approved" | "rejected") => void;
};
const activeRuns = new Map<string, ActiveRun>();
const pendingApprovals = new Map<string, PendingApproval>();

export function createAppServer() {
  return http.createServer(async (request, response) => {
    try {
      await route(request, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal server error";
      json(response, 500, { error: errorPayload(ERROR_CODES.INTERNAL, message) });
    }
  });
}

async function route(request: http.IncomingMessage, response: http.ServerResponse) {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const method = request.method || "GET";
  applyCors(response);
  if (method === "OPTIONS") return empty(response, 204);

  if (method === "GET" && url.pathname === "/health") {
    return json(response, 200, { ok: true, name: "fcode-server", version: "0.1.0" });
  }

  if (url.pathname === "/sessions" && method === "GET") return json(response, 200, { data: listSessions() });
  if (url.pathname === "/sessions" && method === "POST") {
    return json(response, 201, { session: createSession(await readJson(request)) });
  }

  const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?$/);
  if (sessionMatch) return sessionRoute(request, response, url, sessionMatch);

  if (url.pathname === "/workspace/tree" && method === "GET") {
    const root = rootFrom(url);
    const depth = Number(url.searchParams.get("depth") || "3");
    const includeIgnored = url.searchParams.get("includeIgnored") === "1";
    return json(response, 200, { root, data: await readTree(root, depth, includeIgnored) });
  }

  if (url.pathname === "/workspace/file") return workspaceFileRoute(request, response, url);
  if (url.pathname === "/git/status" && method === "GET") return json(response, 200, await gitStatus(rootFrom(url)));
  if (url.pathname === "/git/diff" && method === "GET") return json(response, 200, await gitDiff(rootFrom(url), url.searchParams.get("path")));
  if (url.pathname === "/git/stage" && method === "POST") {
    const body = await readJson(request);
    return json(response, 200, await gitStage(String(body.root || rootFrom(url)), arrayOfStrings(body.paths)));
  }
  if (url.pathname === "/git/commit" && method === "POST") {
    const body = await readJson(request);
    return json(response, 200, await gitCommit(String(body.root || rootFrom(url)), String(body.message || "")));
  }

  return json(response, 404, { error: errorPayload(ERROR_CODES.NOT_FOUND, "Not found") });
}

async function sessionRoute(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  match: RegExpMatchArray,
) {
  const method = request.method || "GET";
  const id = decodeURIComponent(match[1]);
  const action = match[2];
  const subAction = match[3];

  if (!action && method === "GET") {
    const detail = getSessionDetail(id);
    return detail ? json(response, 200, detail) : json(response, 404, { error: errorPayload(ERROR_CODES.SESSION_NOT_FOUND, "Session not found") });
  }
  if (!action && method === "PATCH") return json(response, 200, { session: patchSession(id, await readJson(request)) });
  if (!action && method === "DELETE") {
    deleteSession(id);
    return json(response, 200, { ok: true });
  }
  if (action === "messages" && method === "GET") {
    const detail = getSessionDetail(id);
    return detail
      ? json(response, 200, { data: listMessages(id) })
      : json(response, 404, { error: errorPayload(ERROR_CODES.SESSION_NOT_FOUND, "Session not found") });
  }
  if (action === "messages" && method === "POST") return sendMessage(request, response, id);
  if (action === "events" && !subAction && method === "GET") {
    return json(response, 200, { data: replayEvents(id, url.searchParams.get("lastEventId")) });
  }
  if (action === "events" && subAction === "stream" && method === "GET") return streamEvents(request, response, id, url);
  if (action === "interrupt" && method === "POST") {
    const pending = pendingApprovals.get(id);
    if (pending) {
      pending.resolve("rejected");
      pendingApprovals.delete(id);
    }
    const active = activeRuns.get(id);
    if (active) {
      publishEvent(id, "thinking.done", { message: INTERRUPT_MESSAGE }, { runId: active.runId });
      publishEvent(id, "session.done", { message: INTERRUPT_MESSAGE }, { runId: active.runId });
      active.controller.abort("Interrupted by user");
      activeRuns.delete(id);
      patchSession(id, { status: "idle" });
      return json(response, 200, { interrupted: true, runId: active.runId });
    }
    patchSession(id, { status: "idle" });
    return json(response, 200, { interrupted: false });
  }
  if (action === "approval" && method === "POST") return resolveApproval(request, response, id);
  if (action === "compact" && method === "POST") return compactSession(response, id);

  return json(response, 404, { error: errorPayload(ERROR_CODES.NOT_FOUND, "Not found") });
}

function compactSession(response: http.ServerResponse, sessionId: string) {
  const detail = getSessionDetail(sessionId);
  if (!detail) return json(response, 404, { error: errorPayload(ERROR_CODES.SESSION_NOT_FOUND, "Session not found") });
  if (detail.session.status === "streaming" || detail.session.status === "waiting-approval") {
    return json(response, 409, { error: errorPayload(ERROR_CODES.SESSION_BUSY, "Session is already running") });
  }

  const runId = makeId("compact");
  publishEvent(sessionId, "tool.start", { tool: "context.compact", status: "running", input: {} }, { runId });
  const marker = addMessage({
    id: makeId("msg"),
    sessionId,
    runId,
    role: "system",
    content: "Context compacted",
    createdAt: nowIso(),
    status: "done",
  });
  publishEvent(sessionId, "tool.done", { tool: "context.compact", status: "completed", output: "Context compacted", duration: 0 }, { runId });
  const session = patchSession(sessionId, {});
  return json(response, 200, { ok: true, marker, session });
}

async function sendMessage(request: http.IncomingMessage, response: http.ServerResponse, sessionId: string) {
  const detail = getSessionDetail(sessionId);
  if (!detail) return json(response, 404, { error: errorPayload(ERROR_CODES.SESSION_NOT_FOUND, "Session not found") });
  if (detail.session.status === "streaming" || detail.session.status === "waiting-approval") {
    return json(response, 409, { error: errorPayload(ERROR_CODES.SESSION_BUSY, "Session is already running") });
  }

  const body = await readJson(request);
  const rawContent = String(body.content || "").trim();
  const content = isContinuationPrompt(rawContent) && detail.session.activeGoalObjective
    ? `Continue active objective: ${detail.session.activeGoalObjective}`
    : rawContent;
  if (!content) return json(response, 400, { error: errorPayload(ERROR_CODES.BAD_REQUEST, "content is required") });

  const runId = String(body.runId || makeId("run"));
  const shouldRenameTitle = detail.messages.length === 0;
  const message: Message = {
    id: makeId("msg"),
    sessionId,
    runId,
    role: "user",
    content,
    createdAt: nowIso(),
    status: "done",
  };
  addMessage(message);
  if (shouldRenameTitle || isDefaultSessionTitle(detail.session.title)) {
    patchSession(sessionId, { title: makeSessionTitle(content) });
  }
  if (requiresExecutionGoal(content)) {
    patchSession(sessionId, { activeGoalObjective: content });
    publishEvent(sessionId, "goal.active", { objective: content, status: "active" }, { runId });
  }
  if (isDebugApprovalTrigger(content)) {
    startDebugApprovalRun(sessionId, runId, content);
    return json(response, 202, { message });
  }
  const controller = new AbortController();
  activeRuns.set(sessionId, { runId, controller });
  void runImagegenSkillIfAny(body.input, {
    sessionId,
    runId,
    content,
    workspacePath: detail.session.workspacePath,
    signal: controller.signal,
  })
    .then((result) => {
      if (result.handled) return;
      return runAgentWithProvider(
        sessionId,
        runId,
        content,
        [...detail.messages, message],
        detail.events,
        detail.session.workspacePath,
        detail.session.model,
        detail.session.permission,
        controller,
      );
    })
    .catch((error) => {
      const errorText = `Failed to handle request: ${error instanceof Error ? error.message : String(error)}`;
      addMessage({
        id: makeId("msg"),
        sessionId,
        runId,
        role: "assistant",
        content: errorText,
        createdAt: nowIso(),
        status: "error",
      });
      publishEvent(sessionId, "message.done", { content: errorText, role: "assistant" }, { runId });
      publishEvent(sessionId, "session.error", { message: errorText }, { runId });
      patchSession(sessionId, { status: "idle" });
    })
    .finally(() => {
      const current = activeRuns.get(sessionId);
      if (current?.runId === runId) activeRuns.delete(sessionId);
    });
  return json(response, 202, { message });
}

async function sendMessageLegacyAgent(
  sessionId: string,
  runId: string,
  content: string,
  detail: NonNullable<ReturnType<typeof getSessionDetail>>,
  message: Message,
  controller: AbortController,
) {
  activeRuns.set(sessionId, { runId, controller });
  void runAgentWithProvider(
    sessionId,
    runId,
    content,
    [...detail.messages, message],
    detail.events,
    detail.session.workspacePath,
    detail.session.model,
    detail.session.permission,
    controller,
  )
    .finally(() => {
      const current = activeRuns.get(sessionId);
      if (current?.runId === runId) activeRuns.delete(sessionId);
    });
}

function isDebugApprovalTrigger(content: string) {
  return content.trim().toLowerCase().startsWith("/debug approval");
}

function startDebugApprovalRun(sessionId: string, runId: string, content: string) {
  const command = content.replace(/^\/debug approval\s*/i, "").trim() || "Remove-Item -Recurse temp";
  patchSession(sessionId, { status: "waiting-approval" });
  publishEvent(sessionId, "thinking.start", { message: "Starting debug approval run" }, { runId });
  publishEvent(sessionId, "approval.requested", {
    type: "command",
    command,
    reason: "debug approval trigger",
    hint: "Use approve/reject buttons in activity feed to continue.",
    status: "waiting",
  }, { runId });
  pendingApprovals.set(sessionId, {
    runId,
    request: {
      type: "command",
      command,
      reason: "debug approval trigger",
      hint: "Use approve/reject buttons in activity feed to continue.",
    },
    resolve: (decision) => {
      publishEvent(sessionId, "approval.resolved", { type: "command", command, decision, status: decision }, { runId });
      const finalMessage = decision === "approved"
        ? `Debug approval accepted. Command simulated: ${command}`
        : "Debug approval rejected by user.";
      addMessage({
        id: makeId("msg"),
        sessionId,
        runId,
        role: "assistant",
        content: finalMessage,
        createdAt: nowIso(),
        status: "done",
      });
      publishEvent(sessionId, "message.done", { content: finalMessage, role: "assistant" }, { runId });
      publishEvent(sessionId, "thinking.done", { message: "Done" }, { runId });
      publishEvent(sessionId, "session.done", { message: "Done" }, { runId });
      patchSession(sessionId, { status: "idle" });
    },
  });
}

function isDefaultSessionTitle(title: string) {
  const value = title.trim().toLowerCase();
  return value === "new chat" || value === "fcode v2 sse demo";
}

function makeSessionTitle(content: string) {
  const line = content
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
  return line || "New chat";
}

async function runAgentWithProvider(
  sessionId: string,
  runId: string,
  content: string,
  history: Message[],
  activity: Array<{ id: string; type: string; sessionId: string; runId?: string; messageId?: string; timestamp: string; payload: Record<string, unknown> }>,
  workspacePath: string,
  model: string,
  permission: string,
  controller: AbortController,
) {
  patchSession(sessionId, { status: "streaming" });
  const assistantId = makeId("msg");
  let finished = false;
  const timeout = setTimeout(() => {
    if (finished || controller.signal.aborted) return;
    controller.abort("Agent run timed out");
    const message = "Run timeout. Session restored to idle.";
    addMessage({
      id: assistantId,
      sessionId,
      runId,
      role: "assistant",
      content: message,
      createdAt: nowIso(),
      status: "error",
    });
    publishEvent(sessionId, "session.error", { message }, { runId, messageId: assistantId });
    publishEvent(sessionId, "message.done", { content: message, role: "assistant" }, { runId, messageId: assistantId });
    publishEvent(sessionId, "session.done", { message }, { runId, messageId: assistantId });
    patchSession(sessionId, { status: "idle" });
  }, AGENT_RUN_TIMEOUT_MS);

  try {
    const result = await executeAgentRuntime({
      content,
      history: history.map((message) => ({
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      })),
      activity,
      workspacePath,
      model,
      permission,
      signal: controller.signal,
      sink: {
        publish: (type, payload) => publishEvent(sessionId, type, payload, { runId, messageId: assistantId }),
        addAssistantMessage: (reply, status) => addMessage({
          id: assistantId,
          sessionId,
          runId,
          role: "assistant",
          content: reply,
          createdAt: nowIso(),
          status,
        }),
        setSessionStatus: (status) => patchSession(sessionId, { status }),
      },
      requestApproval: (request) =>
        new Promise<"approved" | "rejected">((resolve) => {
          pendingApprovals.set(sessionId, { runId, request, resolve });
        }),
    });
    if (result.success && result.objective.requiresExecution && (result.progress.writeActions > 0 || result.progress.commandActions > 0)) {
      patchSession(sessionId, { activeGoalObjective: undefined });
      publishEvent(sessionId, "goal.completed", { status: "completed" }, { runId, messageId: assistantId });
    }
  } finally {
    finished = true;
    clearTimeout(timeout);
    if (getSessionDetail(sessionId)?.session.status === "streaming") {
      const message = "Run ended without final event. Session restored to idle.";
      publishEvent(sessionId, "session.done", { message }, { runId, messageId: assistantId });
      patchSession(sessionId, { status: "idle" });
    }
  }
}

function isContinuationPrompt(content: string) {
  const value = content.trim().toLowerCase();
  return value === "next" || value === "lanjut" || value === "continue" || value === "gas";
}

function requiresExecutionGoal(content: string) {
  return /(buatkan|create|scaffold|implement|refactor|fix|bug|patch|edit|ubah|tambah|hapus|setup|install|jalankan|run|build|test)/i.test(content);
}

async function resolveApproval(request: http.IncomingMessage, response: http.ServerResponse, sessionId: string) {
  const pending = pendingApprovals.get(sessionId);
  if (!pending) {
    return json(response, 409, { error: errorPayload(ERROR_CODES.BAD_REQUEST, "No pending approval request") });
  }
  const body = await readJson(request);
  const decision = String(body.decision || "").trim().toLowerCase();
  if (decision !== "approved" && decision !== "rejected") {
    return json(response, 400, { error: errorPayload(ERROR_CODES.BAD_REQUEST, "decision must be approved or rejected") });
  }
  pending.resolve(decision);
  pendingApprovals.delete(sessionId);
  return json(response, 200, { ok: true, decision, runId: pending.runId });
}

async function collectRuntimeSignals(sessionId: string, runId: string, workspacePath: string, userText: string) {
  const notes: string[] = [];

  publishEvent(sessionId, "tool.start", {
    tool: "workspace.scan",
    input: { depth: 2 },
    status: "running",
  }, { runId });
  try {
    const tree = await readTree(workspacePath, 2, false);
    const summary = summarizeTree(tree);
    publishEvent(sessionId, "tool.done", {
      tool: "workspace.scan",
      output: summary,
      status: "completed",
    }, { runId });
    notes.push(`Workspace scan: ${summary}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    publishEvent(sessionId, "tool.error", { tool: "workspace.scan", message, status: "error" }, { runId });
  }

  publishEvent(sessionId, "cmd.start", {
    pid: 2,
    command: "git status --porcelain=v1",
    cwd: workspacePath,
    shell: "git",
  }, { runId });
  try {
    const status = await gitStatus(workspacePath);
    if (status.isRepo) {
      const summary = `branch=${status.branch} changed=${status.changedFiles} staged=${status.stagedFiles} unstaged=${status.unstagedFiles}`;
      publishEvent(sessionId, "cmd.done", {
        pid: 2,
        command: "git status --porcelain=v1",
        exitCode: 0,
        duration: 0,
        fullOutput: summary,
      }, { runId });
      publishEvent(sessionId, "tool.done", {
        tool: "git.status",
        output: summary,
        status: "completed",
      }, { runId });
      notes.push(`Git status: ${summary}`);
    } else {
      publishEvent(sessionId, "cmd.done", {
        pid: 2,
        command: "git status --porcelain=v1",
        exitCode: 1,
        duration: 0,
        fullOutput: String(status.error || "Not a repository"),
      }, { runId });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    publishEvent(sessionId, "cmd.done", {
      pid: 2,
      command: "git status --porcelain=v1",
      exitCode: 1,
      duration: 0,
      fullOutput: message,
    }, { runId });
  }

  const candidates = extractPathCandidates(userText, workspacePath).slice(0, 3);
  for (const filePath of candidates) {
    publishEvent(sessionId, "tool.start", {
      tool: "file.read",
      input: { path: filePath },
      status: "running",
    }, { runId });
    try {
      const content = await readTextFile(workspacePath, filePath);
      publishEvent(sessionId, "file.edit", {
        path: filePath,
        additions: 0,
        deletions: 0,
        diff: `# preview\n${content.slice(0, 1200)}`,
      }, { runId });
      publishEvent(sessionId, "tool.done", {
        tool: "file.read",
        output: `${filePath} (${content.length} chars)`,
        status: "completed",
      }, { runId });
      notes.push(`Read file: ${filePath} (${content.length} chars)`);
    } catch {
      publishEvent(sessionId, "tool.error", {
        tool: "file.read",
        message: `Cannot read ${filePath}`,
        status: "error",
      }, { runId });
    }
  }

  return notes.join("\n");
}

function summarizeTree(nodes: Array<{ type: string; children?: unknown[] }>) {
  let files = 0;
  let dirs = 0;
  const stack = [...nodes];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.type === "directory") {
      dirs += 1;
      if (Array.isArray(node.children)) stack.push(...(node.children as Array<{ type: string; children?: unknown[] }>));
    } else {
      files += 1;
    }
  }
  return `${dirs} dirs, ${files} files (depth 2)`;
}

function extractPathCandidates(text: string, workspacePath: string) {
  const found = new Set<string>();
  const winAbsMatches = text.match(/[A-Za-z]:\\[^\s"'`]+/g) ?? [];
  for (const raw of winAbsMatches) {
    const abs = raw.replace(/\\/g, "\\");
    const rel = toRelativeWorkspacePath(abs, workspacePath);
    if (rel) found.add(rel);
  }
  const relMatches = text.match(/(?:^|[\s"'`])([A-Za-z0-9_.\-\\/]+\.[A-Za-z0-9]{1,8})(?=$|[\s"'`])/g) ?? [];
  for (const raw of relMatches) {
    const clean = raw.trim().replace(/^["'`]|["'`]$/g, "").replace(/\//g, "\\");
    if (clean.startsWith(".git\\")) continue;
    if (clean.includes(":")) continue;
    found.add(clean.replace(/^\.\\/, ""));
  }
  return [...found];
}

function toRelativeWorkspacePath(absPath: string, workspacePath: string) {
  const root = path.resolve(workspacePath).toLowerCase();
  const resolved = path.resolve(absPath);
  const lower = resolved.toLowerCase();
  if (lower !== root && !lower.startsWith(`${root}${path.sep}`)) return null;
  return path.relative(workspacePath, resolved).replace(/\//g, "\\");
}

async function generateAssistantReply(
  userText: string,
  workspacePath: string,
  sessionModel: string,
  permission: string,
  signal: AbortSignal,
) {
  const runtime = readRuntimeConfig();
  const instructions = buildRuntimeInstructions(workspacePath, permission, runtime.instructions);

  const model = (sessionModel || "").trim() || runtime.model;
  const auth = resolveProviderAuth(runtime.provider, engineHomePath());
  if (!auth.token) throw new Error("Provider auth missing. Set API key or enable OAuth token.");
  const errors: string[] = [];

  if ((runtime.provider.wireApi || "").toLowerCase() === "responses") {
    const byResponses = await callResponsesApi(auth.baseUrl, auth.token, auth.accountId, model, userText, instructions, signal).catch((error) => {
      const message = error instanceof Error ? error.message : String(error || "");
      errors.push(message || "responses failed");
      if (shouldForceRefresh(error) && auth.mode === "oauth" && forceRefreshOauthToken(engineHomePath())) return "";
      return "";
    });
    if (byResponses.trim()) return byResponses.trim();
  }

  if (auth.mode === "oauth") {
    if (errors.length) throw new Error([...new Set(errors)].join("; "));
    throw new Error("Empty response from provider");
  }

  const retryAuth = resolveProviderAuth(runtime.provider, engineHomePath());
  const byChatCompletions = await callChatCompletionsApi(retryAuth.baseUrl, retryAuth.token, retryAuth.accountId, model, userText, instructions, signal).catch((error) => {
    const message = error instanceof Error ? error.message : String(error || "");
    errors.push(message || "chat/completions failed");
    if (shouldForceRefresh(error) && retryAuth.mode === "oauth" && forceRefreshOauthToken(engineHomePath())) return "";
    return "";
  });
  if (byChatCompletions.trim()) return byChatCompletions.trim();
  if (errors.length) throw new Error([...new Set(errors)].join("; "));
  throw new Error("Empty response from provider");
}

async function callResponsesApi(
  baseUrl: string,
  apiKey: string,
  accountId: string | undefined,
  model: string,
  userText: string,
  instructions: string,
  signal: AbortSignal,
) {
  const compatHeaders = buildProviderCompatHeaders(accountId);
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...compatHeaders,
    },
    body: JSON.stringify({
      model,
      store: false,
      stream: true,
      instructions,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: userText }],
        },
      ],
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`responses API ${response.status}${text ? `: ${safeError(text)}` : ""}`);
  }
  return readResponsesOutput(response);
}

async function callChatCompletionsApi(
  baseUrl: string,
  apiKey: string,
  accountId: string | undefined,
  model: string,
  userText: string,
  instructions: string,
  signal: AbortSignal,
) {
  const compatHeaders = buildProviderCompatHeaders(accountId);
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...compatHeaders,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: userText },
      ],
      stream: false,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`chat/completions API ${response.status}${text ? `: ${safeError(text)}` : ""}`);
  }
  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return payload.choices?.[0]?.message?.content?.trim() || "";
}

function buildRuntimeInstructions(workspacePath: string, permission: string, customInstructions?: string) {
  const base = [
    "You are FCode coding assistant.",
    `Current workspace root: ${workspacePath}`,
    `Current runtime permission mode: ${permission}`,
    "Always reason and answer using this workspace context.",
    "Never claim you do not know runtime permission mode when it is provided above.",
    "If user asks to run command, mention exact command to run.",
  ];
  const custom = (customInstructions || "").trim();
  if (custom) {
    base.push("User custom instructions:");
    base.push(custom);
  }
  return base.join("\n");
}

function readRuntimeConfig() {
  const home = engineHomePath() || resolveFencodeHome();
  const file = path.join(home, "config.json");
  if (!fs.existsSync(file)) {
    return {
      model: "gpt-5.5",
      provider: {
        baseUrl: "http://127.0.0.1:20128/v1",
        wireApi: "responses",
      },
    };
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
    model?: string;
    instructions?: string;
    provider?: { baseUrl?: string; wireApi?: string };
  };
  return {
    model: raw.model || "gpt-5.5",
    instructions: raw.instructions || "",
    provider: {
      baseUrl: raw.provider?.baseUrl || "http://127.0.0.1:20128/v1",
      wireApi: raw.provider?.wireApi || "responses",
    },
  };
}

function safeError(text: string) {
  return text.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-api-key]").slice(0, 320);
}

async function readResponsesOutput(response: Response) {
  const raw = await response.text();
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    const payload = JSON.parse(trimmed) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    };
    if (payload.output_text?.trim()) return payload.output_text;
    return (payload.output ?? [])
      .flatMap((row) => row.content ?? [])
      .filter((row) => row.type?.includes("text"))
      .map((row) => row.text || "")
      .join("\n")
      .trim();
  }

  const chunks: string[] = [];
  let lastOutputText = "";
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((line) => line.startsWith("data:"));
    if (!lines.length) continue;
    const data = lines.map((line) => line.slice(5).trim()).join("");
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      const delta = extractResponseDelta(parsed);
      if (delta) chunks.push(delta);
      const completed = extractResponseCompletedText(parsed);
      if (completed) lastOutputText = completed;
    } catch {
      continue;
    }
  }
  return chunks.join("").trim() || lastOutputText.trim();
}

function extractResponseDelta(payload: Record<string, unknown>) {
  if (typeof payload.delta === "string") return payload.delta;
  if (typeof payload.output_text === "string") return payload.output_text;
  if (payload.type === "response.output_text.delta" && typeof payload.delta === "string") return payload.delta;
  const item = payload.item as Record<string, unknown> | undefined;
  if (item && typeof item.delta === "string") return item.delta;
  return "";
}

function extractResponseCompletedText(payload: Record<string, unknown>) {
  if (typeof payload.output_text === "string") return payload.output_text;
  const response = payload.response as { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> } | undefined;
  if (response?.output_text?.trim()) return response.output_text;
  return (response?.output ?? [])
    .flatMap((row) => row.content ?? [])
    .filter((row) => row.type?.includes("text"))
    .map((row) => row.text || "")
    .join("\n")
    .trim();
}

function buildProviderCompatHeaders(accountId: string | undefined) {
  return {
    "x-client-request-id": randomUUID(),
    "x-codex-window-id": process.env.FCODE_WINDOW_ID || "1",
    ...(accountId ? { "ChatGPT-Account-ID": accountId } : {}),
  };
}

function shouldForceRefresh(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /\b(401|403)\b/.test(message);
}

async function workspaceFileRoute(request: http.IncomingMessage, response: http.ServerResponse, url: URL) {
  const method = request.method || "GET";
  if (method === "GET") {
    const root = rootFrom(url);
    const filePath = url.searchParams.get("path") || "README.md";
    const content = await readTextFile(root, filePath);
    return json(response, 200, { path: filePath, content, language: path.extname(filePath).slice(1) || "text" });
  }
  if (method === "POST") {
    const body = await readJson(request);
    await writeTextFile(String(body.root || rootFrom(url)), String(body.path || ""), String(body.content || ""));
    return json(response, 200, { ok: true, path: body.path });
  }
  if (method === "DELETE") {
    await deletePath(rootFrom(url), String(url.searchParams.get("path") || ""));
    return json(response, 200, { ok: true });
  }
  return json(response, 405, { error: "Method not allowed" });
}

function streamEvents(request: http.IncomingMessage, response: http.ServerResponse, sessionId: string, url: URL) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  for (const event of replayEvents(sessionId, request.headers["last-event-id"]?.toString() || url.searchParams.get("lastEventId"))) {
    response.write(encodeSse(event));
  }
  const bus = sessionBus(sessionId);
  const onEvent = (event: unknown) => response.write(encodeSse(event as never));
  bus.on("event", onEvent);
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15000);
  request.on("close", () => {
    clearInterval(heartbeat);
    bus.off("event", onEvent);
  });
}

async function readJson(request: http.IncomingMessage): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonBody;
}

function json(response: http.ServerResponse, status: number, body: unknown) {
  applyCors(response);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function empty(response: http.ServerResponse, status: number) {
  applyCors(response);
  response.writeHead(status);
  response.end();
}

function applyCors(response: http.ServerResponse) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type,Last-Event-ID");
}

function rootFrom(url: URL) {
  return url.searchParams.get("root") || engineWorkspacePath();
}

function arrayOfStrings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
