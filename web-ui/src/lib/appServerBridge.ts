import { addMessage, findSessionIdByThreadId, getSession, patchSession, updateMessage } from "./db";
import { makeId, nowIso } from "./id";
import { publishEvent } from "./sse";
import { cleanDisplayText } from "./text";
import type { AgentInputItem } from "@/types/agentInput";
import type { Session, SessionDetail } from "@/types/session";
import type { ConfigEdit } from "./fcodeConfig";

type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type BridgeContext = {
  sessionId: string;
  runId: string;
  assistantId: string;
  threadId: string;
  sourceInput: AgentInputItem[];
  turnId?: string;
  content: string;
  textQueue: Promise<void>;
  commands: Map<string, { startedAt: number; output: string; pid: number; command: string; outputEvents: number }>;
  retryCount: number;
};

type ThreadResponse = { thread?: { id: string; preview?: string; name?: string | null } };
type TurnResponse = { turn?: { id: string } };

const globalBridge = globalThis as typeof globalThis & {
  __fcodeAppServerBridge?: AppServerBridge;
};

export function appServerBridge() {
  globalBridge.__fcodeAppServerBridge ??= new AppServerBridge();
  return globalBridge.__fcodeAppServerBridge;
}

export async function runAppServerTurn(sessionId: string, content: string, runId: string, input?: AgentInputItem[]) {
  return appServerBridge().runTurn(sessionId, content, runId, input);
}

export async function interruptAppServerTurn(sessionId: string) {
  return appServerBridge().interruptTurn(sessionId);
}

export async function compactAppServerThread(sessionId: string) {
  return appServerBridge().compactThread(sessionId);
}

export async function compactAppServerThreadFast(sessionId: string, timeoutMs = 6_000) {
  return withTimeout(compactAppServerThread(sessionId), timeoutMs, "context compaction still running");
}

export async function hotReloadFcodeConfig(edits: ConfigEdit[], filePath: string) {
  return appServerBridge().writeConfig(edits, filePath);
}

const CONNECT_TIMEOUT_MS = 8_000;
const TURN_START_TIMEOUT_MS = 12_000;
const FIRST_EVENT_TIMEOUT_MS = 180_000;
const STALL_RETRY_WAIT_MS = 45_000;
const COMPACT_TIMEOUT_MS = 120_000;
const WAITING_STATUS_INTERVAL_MS = 30_000;
const MAX_STORED_COMMAND_OUTPUT = 20_000;
const MAX_LIVE_OUTPUT_EVENTS = 12;
const MAX_LIVE_OUTPUT_CHUNK = 1_200;
const STREAM_CHUNK_SIZE = 24;
const STREAM_CHUNK_DELAY_MS = 18;

class AppServerBridge {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private initialized = false;
  private connecting?: Promise<void>;
  private pending = new Map<number | string, PendingRequest>();
  private contextsByThread = new Map<string, BridgeContext>();
  private contextsByTurn = new Map<string, BridgeContext>();
  private contextsBySession = new Map<string, BridgeContext>();
  private compactWaiters = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  async writeConfig(edits: ConfigEdit[], filePath: string) {
    await withTimeout(this.connect(), CONNECT_TIMEOUT_MS, "app-server connect timed out");
    return this.request("config/batchWrite", {
      edits,
      filePath,
      reloadUserConfig: true,
    });
  }

  async runTurn(sessionId: string, content: string, runId: string, input?: AgentInputItem[]) {
    const detail = getSession(sessionId);
    if (!detail) throw new Error("Session not found");

    patchSession(sessionId, { status: "streaming" });
    publishEvent(sessionId, "thinking.start", { message: "Connecting to FCode app-server" }, { runId });

    const session = await this.ensureThread(detail.session);
    const assistantId = makeId("msg");
    addMessage({
      id: assistantId,
      sessionId,
      runId,
      role: "assistant",
      content: "",
      createdAt: nowIso(),
      status: "streaming",
    });

    const sourceInput: AgentInputItem[] = input?.length
      ? input
      : [{ type: "text", text: content, textElements: [], text_elements: [] }];
    const context: BridgeContext = {
      sessionId,
      runId,
      assistantId,
      threadId: session.threadId!,
      sourceInput,
      content: "",
      textQueue: Promise.resolve(),
      commands: new Map(),
      retryCount: 0,
    };
    this.contextsByThread.set(session.threadId!, context);
    this.contextsBySession.set(sessionId, context);

    try {
      publishEvent(sessionId, "thinking.delta", { message: "Starting turn" }, { runId });
      const response = await withTimeout(this.startTurn(session, content, sourceInput), TURN_START_TIMEOUT_MS, "turn/start timed out");
      if (response.turn?.id) {
        context.turnId = response.turn.id;
        this.contextsByTurn.set(response.turn.id, context);
      }
      this.watchFirstEvent(context);
    } catch (error) {
      this.failContext(context, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async interruptTurn(sessionId: string) {
    const context = this.contextsBySession.get(sessionId);
    if (!context) {
      patchSession(sessionId, { status: "idle", threadId: undefined });
      return { interrupted: false };
    }
    const content = context.content.trim() || "Stopped by user.";
    updateMessage(context.sessionId, context.assistantId, { content, status: "done" });
    publishEvent(context.sessionId, "message.done", { content, role: "assistant" }, {
      runId: context.runId,
      messageId: context.assistantId,
    });
    publishEvent(context.sessionId, "thinking.done", { message: "Stopped by user" }, { runId: context.runId });
    publishEvent(context.sessionId, "session.done", { message: "Stopped by user" }, { runId: context.runId });
    patchSession(context.sessionId, { status: "idle", threadId: undefined });
    this.clearContext(context);
    void this.interruptStalledTurn(context);
    return { interrupted: true };
  }

  async compactThread(sessionId: string) {
    const detail = getSession(sessionId);
    if (!detail?.session.threadId) return { ok: false, reason: "No app-server thread yet" };
    await withTimeout(this.connect(), CONNECT_TIMEOUT_MS, "app-server connect timed out");
    const done = this.waitForCompaction(detail.session.threadId);
    try {
      await this.request("thread/compact/start", { threadId: detail.session.threadId });
    } catch (error) {
      this.rejectCompaction(detail.session.threadId, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    await done;
    return { ok: true };
  }

  private async ensureThread(session: Session) {
    await withTimeout(this.connect(), CONNECT_TIMEOUT_MS, "app-server connect timed out");
    if (session.threadId) return session;

    const response = await this.request<ThreadResponse>("thread/start", {
      cwd: session.workspacePath,
      model: session.model,
      sandbox: toSandboxMode(session.permission),
    });
    const threadId = response.thread?.id;
    if (!threadId) throw new Error("app-server did not return thread id");
    const updated = patchSession(session.id, { threadId });
    if (!updated) throw new Error("Session not found");
    return updated;
  }

  private async startTurn(session: Session, content: string, input?: AgentInputItem[]) {
    const turnInput = normalizeTurnInput(
      input?.length ? input : [{ type: "text", text: content, textElements: [], text_elements: [] }],
      session,
    );
    try {
      return await this.request<TurnResponse>("turn/start", {
        threadId: session.threadId,
        input: turnInput,
        cwd: session.workspacePath,
        model: session.model,
        sandboxPolicy: toSandboxPolicy(session.permission),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const staleThread = message.includes("not found") || message.includes("unknown") || message.includes("thread");
      if (!staleThread) throw error;
      const fresh = await this.createThread(session);
      return this.request<TurnResponse>("turn/start", {
        threadId: fresh.threadId,
        input: turnInput,
        cwd: fresh.workspacePath,
        model: fresh.model,
        sandboxPolicy: toSandboxPolicy(fresh.permission),
      });
    }
  }

  private async createThread(session: Session) {
    const response = await this.request<ThreadResponse>("thread/start", {
      cwd: session.workspacePath,
      model: session.model,
      sandbox: toSandboxMode(session.permission),
    });
    const threadId = response.thread?.id;
    if (!threadId) throw new Error("app-server did not return thread id");
    const updated = patchSession(session.id, { threadId });
    if (!updated) throw new Error("Session not found");
    return updated;
  }

  private async connect() {
    if (this.socket?.readyState === WebSocket.OPEN && this.initialized) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(process.env.FCODE_APP_SERVER_URL || "ws://127.0.0.1:7070");
      this.socket = socket;
      socket.onopen = async () => {
        try {
          await this.request("initialize", {
            clientInfo: { name: "fcode_web_ui_v2", title: "FCode Web UI V2", version: "0.2.0" },
            capabilities: { experimentalApi: true },
          });
          this.notify("initialized", {});
          this.initialized = true;
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          this.connecting = undefined;
        }
      };
      socket.onerror = () => {
        this.connecting = undefined;
        reject(new Error("Cannot connect to FCode app-server at ws://127.0.0.1:7070"));
      };
      socket.onclose = () => {
        this.initialized = false;
        this.socket = null;
      };
      socket.onmessage = (event) => this.handleMessage(String(event.data));
    });

    return this.connecting;
  }

  private request<T>(method: string, params?: unknown): Promise<T> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("app-server websocket is not connected"));
    }
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server timeout: ${method}`));
      }, 45_000);
      this.pending.set(id, {
        timer,
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
  }

  private notify(method: string, params?: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ method, params }));
    }
  }

  private respond(id: number | string, result: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ id, result }));
    }
  }

  private handleMessage(raw: string) {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || "app-server request failed"));
        return;
      }
      pending.resolve(message.result);
      return;
    }
    if (message.method) this.handleNotification(message.method, message.params);
  }

  private handleServerRequest(message: JsonRpcMessage) {
    if (message.id === undefined) return;
    const action = readString(message.params, "action") || message.method || "permission";
    const context = this.contextFromParams(message.params);
    if (context) {
      publishEvent(context.sessionId, "permission.request", {
        id: String(message.id),
        action,
        risk: "medium",
        details: JSON.stringify(message.params ?? {}, null, 2),
        timeout: 60,
      }, { runId: context.runId });
    }
    this.respond(message.id, { decision: "approved", approved: true });
  }

  private handleNotification(method: string, params: unknown) {
    if (method === "item/started" || method === "item/completed") {
      const item = readObject(params, "item");
      const type = readString(item, "type");
      if (type === "contextCompaction") {
        const threadId = readString(params, "threadId") || readNestedString(params, ["thread", "id"]);
        const sessionId = threadId ? findSessionIdByThreadId(threadId) : null;
        if (method === "item/started" && sessionId) {
          publishEvent(sessionId, "tool.start", {
            tool: "context.compact",
            input: { threadId },
          });
        }
        if (method === "item/completed") {
          this.resolveCompaction(threadId);
          if (sessionId) {
            publishEvent(sessionId, "tool.done", {
              tool: "context.compact",
              output: "Thread context compacted",
              duration: 0,
            });
          }
        }
        return;
      }
    }

    if (method === "thread/compacted") {
      const threadId = readString(params, "threadId");
      this.resolveCompaction(threadId);
      const sessionId = threadId ? findSessionIdByThreadId(threadId) : null;
      if (sessionId) {
        publishEvent(sessionId, "tool.done", {
          tool: "context.compact",
          output: "Thread context compacted",
          duration: 0,
        });
      }
      return;
    }

    const context = this.contextFromParams(params);
    if (!context && method !== "error") return;

    if (method === "item/agentMessage/delta" && context) {
      const delta = readString(params, "delta");
      this.enqueueTextDelta(context, delta);
      return;
    }

    if (method === "item/commandExecution/outputDelta" && context) {
      const itemId = readString(params, "itemId");
      const command = context.commands.get(itemId);
      const delta = readString(params, "delta");
      if (!command) return;
      command.output += delta;
      if (command.outputEvents >= MAX_LIVE_OUTPUT_EVENTS) return;
      command.outputEvents += 1;
      publishEvent(context.sessionId, "cmd.output", {
        pid: command?.pid ?? 0,
        stream: "stdout",
        chunk: truncateLiveOutput(delta),
      }, { runId: context.runId });
      return;
    }

    if (method === "item/fileChange/patchUpdated" && context) {
      for (const change of readArray(params, "changes")) {
        const path = readString(change, "path");
        const diff = readString(change, "diff");
        publishEvent(context.sessionId, "file.edit", {
          path,
          diff,
          hunks: Math.max(1, (diff.match(/^@@/gm) ?? []).length),
          additions: countLines(diff, "+"),
          deletions: countLines(diff, "-"),
          expandable: diff.length > 400,
        }, { runId: context.runId });
      }
      return;
    }

    if (method === "item/started" && context) {
      this.handleItemStarted(context, params);
      return;
    }

    if (method === "item/completed" && context) {
      this.handleItemCompleted(context, params);
      return;
    }

    if (method === "turn/completed" && context) {
      this.completeTurn(context, params);
      return;
    }

    if (method === "error") {
      const message = readString(params, "message") || readNestedString(params, ["error", "message"]) || "app-server error";
      if (context) this.failContext(context, message);
    }
  }

  private watchFirstEvent(context: BridgeContext) {
    const initialContent = context.content;
    const initialCommandCount = context.commands.size;
    const hasProgress = () => context.content !== initialContent || context.commands.size !== initialCommandCount;
    const stillActive = () => [...this.contextsByTurn.values()].includes(context) || [...this.contextsByThread.values()].includes(context);
    const waitingTimer = setInterval(() => {
      if (!stillActive() || hasProgress()) {
        clearInterval(waitingTimer);
        return;
      }
      publishEvent(context.sessionId, "thinking.delta", {
        message: "Waiting for app-server response",
      }, { runId: context.runId });
    }, WAITING_STATUS_INTERVAL_MS);
    const retryTimer = setTimeout(() => {
      if (!stillActive() || hasProgress()) return;
      void this.retryStalledContext(context, "No app-server activity after 45s. Retrying once with fresh thread.");
    }, STALL_RETRY_WAIT_MS);
    setTimeout(() => {
      clearInterval(waitingTimer);
      clearTimeout(retryTimer);
      const stillActive = [...this.contextsByTurn.values()].includes(context) || [...this.contextsByThread.values()].includes(context);
      if (!stillActive) return;
      if (!hasProgress()) {
        void this.interruptStalledTurn(context);
        this.failContext(context, "No app-server activity after 180s. The model may be stalled or the target command is waiting.");
      }
    }, FIRST_EVENT_TIMEOUT_MS);
  }

  private async interruptStalledTurn(context: BridgeContext) {
    if (!context.turnId) return;
    try {
      await this.request("turn/interrupt", { threadId: context.threadId, turnId: context.turnId });
    } catch {
      // The turn is already stale or app-server is not accepting cancellation.
    }
    try {
      await this.request("thread/backgroundTerminals/clean", { threadId: context.threadId });
    } catch {
      // Best-effort cleanup only.
    }
  }

  private async retryStalledContext(context: BridgeContext, reason: string) {
    if (context.retryCount >= 1) return;
    context.retryCount += 1;
    publishEvent(context.sessionId, "thinking.delta", { message: reason }, { runId: context.runId });
    publishEvent(context.sessionId, "tool.start", {
      tool: "system.self-heal",
      status: "retrying",
      message: "Auto-retry triggered",
    }, { runId: context.runId });
    await this.interruptStalledTurn(context);
    patchSession(context.sessionId, { threadId: undefined, status: "streaming" });
    const session = getSession(context.sessionId)?.session;
    if (!session) return;
    const fresh = await this.ensureThread(session);
    context.threadId = fresh.threadId || context.threadId;
    this.contextsBySession.set(context.sessionId, context);
    this.contextsByThread.set(context.threadId, context);
    const response = await withTimeout(this.startTurn(fresh, context.content || "Continue.", context.sourceInput), TURN_START_TIMEOUT_MS, "turn/start retry timed out");
    if (response.turn?.id) {
      context.turnId = response.turn.id;
      this.contextsByTurn.set(response.turn.id, context);
    }
    publishEvent(context.sessionId, "tool.done", {
      tool: "system.self-heal",
      status: "recovered",
      message: "Recovered with new thread",
    }, { runId: context.runId });
  }

  private handleItemStarted(context: BridgeContext, params: unknown) {
    const item = readObject(params, "item");
    const type = readString(item, "type");
    const itemId = readString(item, "id");
    const turnId = readString(params, "turnId");
    if (turnId) this.contextsByTurn.set(turnId, context);

    if (type === "commandExecution") {
      const command = readString(item, "command");
      const pid = Math.floor(Math.random() * 100000);
      context.commands.set(itemId, { startedAt: Date.now(), output: "", pid, command, outputEvents: 0 });
      publishEvent(context.sessionId, "cmd.start", {
        command,
        shell: "powershell",
        cwd: readString(item, "cwd"),
        pid,
      }, { runId: context.runId });
      return;
    }

    if (type === "agentMessage" || type === "reasoning") {
      publishEvent(context.sessionId, "thinking.delta", {
        message: type === "agentMessage" ? "Writing response" : "Reasoning",
      }, { runId: context.runId });
      return;
    }

    if (type === "contextCompaction") {
      publishEvent(context.sessionId, "tool.start", {
        tool: "context.compact",
        input: { threadId: context.threadId },
      }, { runId: context.runId });
      return;
    }

    if (type === "fileChange") {
      publishEvent(context.sessionId, "tool.start", { tool: "file.change", status: readString(item, "status") }, { runId: context.runId });
      return;
    }

    if (type === "webSearch") {
      publishEvent(context.sessionId, "web.search.start", {
        query: readString(item, "query"),
        engine: "codex",
      }, { runId: context.runId });
      return;
    }

    if (type === "mcpToolCall" || type === "dynamicToolCall") {
      publishEvent(context.sessionId, "tool.start", {
        tool: readString(item, "tool") || type,
        server: readString(item, "server"),
      }, { runId: context.runId });
    }
  }

  private handleItemCompleted(context: BridgeContext, params: unknown) {
    const item = readObject(params, "item");
    const type = readString(item, "type");
    const itemId = readString(item, "id");

    if (type === "agentMessage") {
      const text = readString(item, "text");
      if (text) {
        const delta = text.startsWith(context.content) ? text.slice(context.content.length) : text;
        if (delta) this.enqueueTextDelta(context, delta, { chunkLargeDelta: true });
      }
      return;
    }

    if (type === "commandExecution") {
      const command = context.commands.get(itemId);
      const output = readString(item, "aggregatedOutput") || command?.output || "";
      const storedOutput = truncateOutput(output);
      publishEvent(context.sessionId, "cmd.done", {
        pid: command?.pid ?? 0,
        exitCode: Number(readValue(item, "exitCode") ?? 0),
        duration: Date.now() - (command?.startedAt ?? Date.now()),
        fullOutput: storedOutput,
        expandable: storedOutput.length > 800,
      }, { runId: context.runId });
      return;
    }

    if (type === "webSearch") {
      publishEvent(context.sessionId, "web.search.done", { results: [], count: 0 }, { runId: context.runId });
      return;
    }

    if (type === "contextCompaction") {
      publishEvent(context.sessionId, "tool.done", {
        tool: "context.compact",
        output: "Thread context compacted",
        duration: 0,
      }, { runId: context.runId });
      return;
    }

    if (type === "mcpToolCall" || type === "dynamicToolCall" || type === "fileChange") {
      publishEvent(context.sessionId, "tool.done", {
        tool: readString(item, "tool") || type,
        status: readString(item, "status") || "completed",
      }, { runId: context.runId });
    }
  }

  private completeTurn(context: BridgeContext, params: unknown) {
    void this.completeTurnAfterText(context, params);
  }

  private async completeTurnAfterText(context: BridgeContext, params: unknown) {
    const fallback = extractFinalText(params);
    if (!context.content && fallback) this.enqueueTextDelta(context, fallback, { chunkLargeDelta: true });
    await context.textQueue;
    const content = context.content;
    updateMessage(context.sessionId, context.assistantId, { content, status: "done" });
    publishEvent(context.sessionId, "message.done", { content, role: "assistant" }, {
      runId: context.runId,
      messageId: context.assistantId,
    });
    publishEvent(context.sessionId, "thinking.done", { message: "Reasoning complete" }, { runId: context.runId });
    publishEvent(context.sessionId, "session.done", { message: "Agent idle" }, { runId: context.runId });
    patchSession(context.sessionId, { status: "idle" });
    this.clearContext(context, readString(params, "threadId"), readNestedString(params, ["turn", "id"]));
  }

  private enqueueTextDelta(context: BridgeContext, rawDelta: string, options: { chunkLargeDelta?: boolean } = {}) {
    const delta = removeRepeatedPrefix(cleanDisplayText(rawDelta), context.content);
    if (!delta) return;
    const chunks = options.chunkLargeDelta && delta.length > STREAM_CHUNK_SIZE
      ? chunkText(delta, STREAM_CHUNK_SIZE)
      : [delta];
    context.textQueue = context.textQueue.then(async () => {
      for (const chunk of chunks) {
        context.content += chunk;
        publishEvent(context.sessionId, "message.delta", { content: chunk, role: "assistant" }, {
          runId: context.runId,
          messageId: context.assistantId,
        });
        updateMessage(context.sessionId, context.assistantId, { content: context.content, status: "streaming" });
        if (chunks.length > 1) await sleep(STREAM_CHUNK_DELAY_MS);
      }
    });
  }

  private failContext(context: BridgeContext, message: string) {
    updateMessage(context.sessionId, context.assistantId, { content: message, status: "error" });
    publishEvent(context.sessionId, "message.done", { content: message, role: "assistant" }, {
      runId: context.runId,
      messageId: context.assistantId,
    });
    publishEvent(context.sessionId, "session.error", { message }, { runId: context.runId });
    patchSession(context.sessionId, { status: "idle", threadId: undefined });
    this.clearContext(context);
  }

  private clearContext(context: BridgeContext, threadId?: string, turnId?: string) {
    this.contextsBySession.delete(context.sessionId);
    if (threadId) this.contextsByThread.delete(threadId);
    if (turnId) this.contextsByTurn.delete(turnId);
    for (const [knownTurnId, existing] of this.contextsByTurn.entries()) {
      if (existing === context) this.contextsByTurn.delete(knownTurnId);
    }
    for (const [knownThreadId, existing] of this.contextsByThread.entries()) {
      if (existing === context) this.contextsByThread.delete(knownThreadId);
    }
  }

  private contextFromParams(params: unknown) {
    const turnId = readString(params, "turnId") || readNestedString(params, ["turn", "id"]);
    const threadId = readString(params, "threadId");
    return this.contextsByTurn.get(turnId) ?? this.contextsByThread.get(threadId);
  }

  private waitForCompaction(threadId: string) {
    return new Promise<void>((resolve, reject) => {
      const existing = this.compactWaiters.get(threadId);
      if (existing) {
        clearTimeout(existing.timer);
        existing.reject(new Error("Superseded by a newer compact request"));
      }
      const timer = setTimeout(() => {
        this.compactWaiters.delete(threadId);
        reject(new Error("context compaction timed out"));
      }, COMPACT_TIMEOUT_MS);
      this.compactWaiters.set(threadId, { resolve, reject, timer });
    });
  }

  private resolveCompaction(threadId: string) {
    const waiter = this.compactWaiters.get(threadId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.compactWaiters.delete(threadId);
    waiter.resolve();
  }

  private rejectCompaction(threadId: string, error: Error) {
    const waiter = this.compactWaiters.get(threadId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.compactWaiters.delete(threadId);
    waiter.reject(error);
  }
}

function normalizeTurnInput(input: AgentInputItem[], session: Session) {
  const normalized: AgentInputItem[] = [];
  const selectedSkills: Array<Extract<AgentInputItem, { type: "skill" }>> = [];
  let combinedText = "";
  for (const item of input) {
    if (item.type === "skill") {
      selectedSkills.push(item);
      continue;
    }
    if (item.type === "text") combinedText += `\n${item.text}`;
    normalized.push(item);
  }
  if (selectedSkills.length) {
    normalized.push({
      type: "text",
      text: `\n\nSelected skills:\n${selectedSkills.map((skill) => `- ${skill.label}: ${skill.value}`).join("\n")}`,
      textElements: [],
      text_elements: [],
    });
  }
  if (shouldAttachSkillInstallNote(combinedText, selectedSkills)) {
    normalized.push({
      type: "text",
      text: [
        "",
        "FCode Skill Installer note:",
        "- Treat this as using the built-in Skill Installer capability.",
        "- Default target for installed skills is FCode Custom Skills in this Web UI.",
        "- If user gives GitHub or raw SKILL.md URL, use that as source of truth and install/update it as Custom Skill.",
        "- Do not ask install path unless user explicitly asks for workspace-local skill files.",
        "- After install, report skill name and trigger clearly.",
      ].join("\n"),
      textElements: [],
      text_elements: [],
    });
  }
  const contextPreamble = buildTurnContextPreamble(session, combinedText);
  if (contextPreamble) {
    normalized.unshift({
      type: "text",
      text: contextPreamble,
      textElements: [],
      text_elements: [],
    });
  }
  return normalized;
}

function buildTurnContextPreamble(session: Session, queryText: string) {
  const detail = getSession(session.id);
  if (!detail) return "";
  const maxMessages = 16;
  const maxEvents = 20;
  const sessionSummary = (detail.session.sessionSummary ?? "").trim();
  const sessionFacts = detail.session.sessionFacts ?? [];
  const compactSummary = (detail.session.compactSummary ?? "").trim();
  const installedSkills = extractInstalledSkills(detail.messages);
  const messages = detail.messages
    .slice(-maxMessages)
    .map((message) => `- ${message.role}: ${trimLine(message.content, 360)}`);
  const relevantMessages = selectRelevantMessages(detail.messages, queryText)
    .map((message) => `- ${message.role}: ${trimLine(message.content, 320)}`);
  const events = detail.events
    .filter((event) => event.type !== "heartbeat" && event.type !== "cmd.output")
    .slice(-maxEvents)
    .map((event) => `- ${event.type}: ${trimLine(eventSummary(event.payload), 220)}`);
  const parts = [
    "FCode Session Context:",
    `- sessionId: ${session.id}`,
    `- model: ${session.model}`,
    `- workspace: ${session.workspacePath}`,
    `- permission: ${session.permission}`,
    `- contextUsage: ${detail.session.contextUsageTokens ?? 0}/${detail.session.contextWindow ?? 0} (${detail.session.contextUsagePct ?? 0}%)`,
    sessionFacts.length ? `- sessionFacts: ${sessionFacts.join(" | ")}` : "",
    sessionSummary ? `\nSession summary:\n${trimLine(sessionSummary, 2200)}` : "",
    installedSkills.length ? `- installedSkillsFromHistory: ${installedSkills.join(", ")}` : "",
    compactSummary ? `\nLast compact summary:\n${trimLine(compactSummary, 1800)}` : "",
    relevantMessages.length ? `\nRelevant older context:\n${relevantMessages.join("\n")}` : "",
    messages.length ? `\nRecent conversation:\n${messages.join("\n")}` : "",
    events.length ? `\nRecent activity:\n${events.join("\n")}` : "",
    "\nInstruction: Continue current task from this context. Avoid repeating solved steps.",
  ].filter(Boolean);
  return parts.join("\n");
}

function extractInstalledSkills(messages: SessionDetail["messages"]) {
  const found = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const match = message.content.match(/Skill\s+(.+?)\s+sudah masuk Custom Skills/i);
    if (!match?.[1]) continue;
    found.add(match[1].trim());
  }
  return [...found].slice(-12);
}

function selectRelevantMessages(messages: SessionDetail["messages"], queryText: string) {
  const queryTokens = tokenizeForContext(queryText);
  if (!queryTokens.length) return [];
  const recentIds = new Set(messages.slice(-16).map((message) => message.id));
  return messages
    .filter((message) => !recentIds.has(message.id))
    .map((message) => ({ message, score: scoreMessageForQuery(message.content, queryTokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((entry) => entry.message);
}

function tokenizeForContext(text: string) {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3);
  return [...new Set(base)];
}

function scoreMessageForQuery(content: string, queryTokens: string[]) {
  const haystack = content.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += token.length >= 8 ? 3 : 2;
  }
  if (haystack.includes("skill") && queryTokens.some((token) => token.includes("skill") || token.includes("install"))) score += 4;
  if (haystack.includes("memory") && queryTokens.some((token) => token.includes("memory") || token.includes("context"))) score += 4;
  if (haystack.includes("waiting for app-server response") && queryTokens.some((token) => token.includes("waiting") || token.includes("response"))) score += 5;
  return score;
}

function eventSummary(payload: unknown) {
  if (!payload || typeof payload !== "object") return String(payload ?? "");
  const data = payload as Record<string, unknown>;
  return String(
    data.message ??
    data.command ??
    data.path ??
    data.query ??
    data.tool ??
    data.action ??
    JSON.stringify(payload),
  );
}

function trimLine(value: string, max: number) {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

function shouldAttachSkillInstallNote(
  combinedText: string,
  selectedSkills: Array<Extract<AgentInputItem, { type: "skill" }>>,
) {
  const lowered = combinedText.toLowerCase();
  if (/\b(install|pasang|tambah|tambahkan)\b/.test(lowered) && /\bskill\b/.test(lowered)) return true;
  return selectedSkills.some((skill) => {
    const id = skill.id.toLowerCase();
    return id.endsWith("skill-installer") || skill.label.toLowerCase().includes("skill installer");
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkText(text: string, size: number) {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

function removeRepeatedPrefix(delta: string, existing: string) {
  if (!delta || !existing) return delta;
  if (existing.endsWith(delta)) return "";
  const max = Math.min(delta.length, existing.length, 240);
  for (let size = max; size > 0; size -= 1) {
    if (existing.endsWith(delta.slice(0, size))) {
      return delta.slice(size);
    }
  }
  return delta;
}

function toSandboxMode(permission: Session["permission"]) {
  if (permission === "read-only") return "read-only";
  if (permission === "workspace-write") return "workspace-write";
  return "danger-full-access";
}

function toSandboxPolicy(permission: Session["permission"]) {
  if (permission === "read-only") return { type: "readOnly", networkAccess: false };
  if (permission === "workspace-write") return { type: "workspaceWrite", writableRoots: [], networkAccess: false };
  return { type: "dangerFullAccess" };
}

function readObject(value: unknown, key: string) {
  const child = readValue(value, key);
  return child && typeof child === "object" ? child : {};
}

function readArray(value: unknown, key: string) {
  const child = readValue(value, key);
  return Array.isArray(child) ? child : [];
}

function readString(value: unknown, key: string) {
  const child = readValue(value, key);
  return typeof child === "string" ? child : "";
}

function readNestedString(value: unknown, path: string[]) {
  let current = value;
  for (const key of path) current = readValue(current, key);
  return typeof current === "string" ? current : "";
}

function readValue(value: unknown, key: string) {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

function countLines(diff: string, prefix: "+" | "-") {
  return diff.split("\n").filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`)).length;
}

function extractFinalText(params: unknown) {
  const turn = readObject(params, "turn");
  const items = readValue(turn, "items");
  if (!Array.isArray(items)) return "";
  const agentMessages = items.filter((item) => readString(item, "type") === "agentMessage");
  const final = agentMessages.at(-1);
  return final ? readString(final, "text") : "";
}

function truncateOutput(output: string) {
  if (output.length <= MAX_STORED_COMMAND_OUTPUT) return output;
  const omitted = output.length - MAX_STORED_COMMAND_OUTPUT;
  return `${output.slice(0, MAX_STORED_COMMAND_OUTPUT)}\n... (${omitted} chars truncated)`;
}

function truncateLiveOutput(output: string) {
  if (output.length <= MAX_LIVE_OUTPUT_CHUNK) return output;
  return `${output.slice(0, MAX_LIVE_OUTPUT_CHUNK)}\n... (live chunk truncated)`;
}
