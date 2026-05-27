import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { makeId, nowIso } from "./id.js";
import type { AgentEvent, Message, Permission, Session } from "./types.js";
import { resolveFencodeHome } from "./runtimeHome.js";

type PersistedStore = {
  sessions: Session[];
  messages: Array<[string, Message[]]>;
  events: Array<[string, AgentEvent[]]>;
};

type CreateSessionInput = {
  title?: string;
  workspacePath?: string;
  model?: string;
  permission?: Permission;
};

type FcodeConfig = {
  version: number;
  createdAt: string;
  modelProvider: string;
  model: string;
  personality: string;
  reasoningEffort: string;
  instructions: string;
  features: { memories: boolean; allowGlobalScan: boolean };
  provider: { id: string; name: string; baseUrl: string; wireApi: string };
  engineServerUrl: string;
  subagentModel: string;
  projects: Array<{ path: string; trustLevel: string }>;
  storage?: { home?: string; db?: string; workspace?: string; skills?: string };
};

const fencodeHomeDir = resolveFencodeHome();
const dataDir = path.join(fencodeHomeDir, "data");
const skillsDir = path.join(fencodeHomeDir, "skills");
const workspaceDir = process.env.DEFAULT_WORKSPACE_PATH || path.join(fencodeHomeDir, "workspace");
const configFile = path.join(fencodeHomeDir, "config.json");
const sqliteFile = path.join(dataDir, "chat-sessions.db");
const legacyJsonFile = path.join(dataDir, "chat-sessions.json");
const seedDir = process.env.FENCODE_SEED_DIR || path.join(process.cwd(), "seed", "fencode");

let db: Database | null = null;

export function loadStore() {
  initializeFencodeHome();
  ensureDatabase();
  migrateLegacyJsonIfNeeded();
  const count = query<{ total: number }>("SELECT COUNT(*) AS total FROM sessions").total;
  if (!count) createSession({ title: "New chat" });
}

export function saveStore() {
  // SQLite writes are committed per operation. Keep no-op for compatibility.
}

export function listSessions() {
  ensureDatabase();
  return all<Session>(
    `SELECT id, threadId, title, workspacePath, model, permission, activeGoalObjective, status, createdAt, updatedAt, contextUsagePct, contextUsageTokens, contextWindow
     FROM sessions
     ORDER BY updatedAt DESC`,
  );
}

export function createSession(input: CreateSessionInput = {}) {
  ensureDatabase();
  const timestamp = nowIso();
  const session: Session = {
    id: makeId("ses"),
    threadId: undefined,
    title: input.title || "New chat",
    workspacePath: normalizeSessionWorkspacePath(input.workspacePath || defaultWorkspacePath()),
    model: input.model || "gpt-5.5",
    permission: input.permission || "workspace-write",
    activeGoalObjective: undefined,
    status: "idle",
    contextUsagePct: 0,
    contextUsageTokens: 0,
    contextWindow: 256000,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  exec(
    `INSERT INTO sessions (id, threadId, title, workspacePath, model, permission, activeGoalObjective, status, createdAt, updatedAt, contextUsagePct, contextUsageTokens, contextWindow)
     VALUES (@id, @threadId, @title, @workspacePath, @model, @permission, @activeGoalObjective, @status, @createdAt, @updatedAt, @contextUsagePct, @contextUsageTokens, @contextWindow)`,
    {
      ...session,
      threadId: session.threadId ?? null,
    },
  );
  return session;
}

export function getSessionDetail(id: string) {
  ensureDatabase();
  const session = query<Session>(
    `SELECT id, threadId, title, workspacePath, model, permission, activeGoalObjective, status, createdAt, updatedAt, contextUsagePct, contextUsageTokens, contextWindow
     FROM sessions WHERE id = ?`,
    [id],
  );
  if (!session) return null;
  return {
    session: {
      ...session,
      workspacePath: normalizeSessionWorkspacePath(session.workspacePath),
    },
    messages: listMessages(id),
    events: listEvents(id),
  };
}

export function patchSession(id: string, patch: Partial<Session>) {
  ensureDatabase();
  const current = getSessionDetail(id)?.session;
  if (!current) return null;
  const next: Session = {
    ...current,
    ...patch,
    id,
    workspacePath: normalizeSessionWorkspacePath((patch.workspacePath ?? current.workspacePath) || ""),
    updatedAt: nowIso(),
  };
  exec(
    `UPDATE sessions
     SET threadId=@threadId, title=@title, workspacePath=@workspacePath, model=@model, permission=@permission, activeGoalObjective=@activeGoalObjective, status=@status,
         updatedAt=@updatedAt, contextUsagePct=@contextUsagePct, contextUsageTokens=@contextUsageTokens, contextWindow=@contextWindow
     WHERE id=@id`,
    next,
  );
  return next;
}

export function deleteSession(id: string) {
  ensureDatabase();
  const tx = useDb().transaction((sessionId: string) => {
    exec("DELETE FROM events WHERE sessionId = ?", [sessionId]);
    exec("DELETE FROM messages WHERE sessionId = ?", [sessionId]);
    exec("DELETE FROM sessions WHERE id = ?", [sessionId]);
  });
  tx(id);
}

export function addMessage(message: Message) {
  ensureDatabase();
  exec(
    `INSERT INTO messages (id, sessionId, runId, role, content, createdAt, status)
     VALUES (@id, @sessionId, @runId, @role, @content, @createdAt, @status)`,
    message,
  );
  exec("UPDATE sessions SET updatedAt = ? WHERE id = ?", [nowIso(), message.sessionId]);
  return message;
}

export function updateMessage(sessionId: string, messageId: string, patch: Pick<Partial<Message>, "content" | "status">) {
  ensureDatabase();
  const current = query<Message>(
    `SELECT id, sessionId, runId, role, content, createdAt, status
     FROM messages
     WHERE sessionId = ? AND id = ?`,
    [sessionId, messageId],
  );
  if (!current) return null;
  const next = { ...current, ...patch };
  exec(
    `UPDATE messages
     SET content = @content, status = @status
     WHERE sessionId = @sessionId AND id = @id`,
    next,
  );
  exec("UPDATE sessions SET updatedAt = ? WHERE id = ?", [nowIso(), sessionId]);
  return next;
}

export function addEvent(event: AgentEvent) {
  ensureDatabase();
  exec(
    `INSERT INTO events (id, sessionId, runId, messageId, type, timestamp, payloadJson)
     VALUES (@id, @sessionId, @runId, @messageId, @type, @timestamp, @payloadJson)`,
    {
      id: event.id,
      sessionId: event.sessionId,
      runId: event.runId ?? null,
      messageId: event.messageId ?? null,
      type: event.type,
      timestamp: event.timestamp,
      payloadJson: JSON.stringify(event.payload ?? {}),
    },
  );
  // Keep bounded history per session.
  exec(
    `DELETE FROM events
     WHERE sessionId = ?
       AND rowid NOT IN (
         SELECT rowid FROM events
         WHERE sessionId = ?
         ORDER BY timestamp DESC, rowid DESC
         LIMIT 1000
       )`,
    [event.sessionId, event.sessionId],
  );
  return event;
}

export function listMessages(sessionId: string) {
  ensureDatabase();
  return all<Message>(
    `SELECT id, sessionId, runId, role, content, createdAt, status
     FROM messages
     WHERE sessionId = ?
     ORDER BY createdAt ASC, rowid ASC`,
    [sessionId],
  );
}

export function listEvents(sessionId: string, lastEventId?: string | null) {
  ensureDatabase();
  const rows = all<{
    id: string;
    sessionId: string;
    runId: string | null;
    messageId: string | null;
    type: string;
    timestamp: string;
    payloadJson: string;
  }>(
    `SELECT id, sessionId, runId, messageId, type, timestamp, payloadJson
     FROM events
     WHERE sessionId = ?
     ORDER BY timestamp ASC, rowid ASC`,
    [sessionId],
  ).map((row) => ({
    id: row.id,
    sessionId: row.sessionId,
    runId: row.runId ?? undefined,
    messageId: row.messageId ?? undefined,
    type: row.type,
    timestamp: row.timestamp,
    payload: safeParseJson(row.payloadJson),
  })) as AgentEvent[];

  if (!lastEventId) return rows.slice(-100);
  const index = rows.findIndex((event) => event.id === lastEventId);
  return index >= 0 ? rows.slice(index + 1) : rows.slice(-100);
}

function ensureDatabase() {
  if (db) return db;
  fs.mkdirSync(dataDir, { recursive: true });
  db = new Database(sqliteFile);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      threadId TEXT,
      title TEXT NOT NULL,
      workspacePath TEXT NOT NULL,
      model TEXT NOT NULL,
      permission TEXT NOT NULL,
      activeGoalObjective TEXT,
      status TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      contextUsagePct INTEGER,
      contextUsageTokens INTEGER,
      contextWindow INTEGER
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL,
      runId TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL,
      runId TEXT,
      messageId TEXT,
      type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      payloadJson TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session_time ON messages(sessionId, createdAt);
    CREATE INDEX IF NOT EXISTS idx_events_session_time ON events(sessionId, timestamp);
  `);
  const columns = all<{ name: string }>("PRAGMA table_info(sessions)").map((row) => row.name);
  if (!columns.includes("activeGoalObjective")) {
    db.exec("ALTER TABLE sessions ADD COLUMN activeGoalObjective TEXT");
  }
  return db;
}

function migrateLegacyJsonIfNeeded() {
  if (!fs.existsSync(legacyJsonFile)) return;
  const hasSessions = query<{ total: number }>("SELECT COUNT(*) AS total FROM sessions").total > 0;
  if (hasSessions) return;
  const raw = fs.readFileSync(legacyJsonFile, "utf8");
  const parsed = JSON.parse(raw) as PersistedStore;
  const tx = useDb().transaction(() => {
    for (const session of parsed.sessions ?? []) {
      const normalized = {
        ...session,
        threadId: session.threadId ?? null,
        activeGoalObjective: session.activeGoalObjective ?? null,
        workspacePath: normalizeSessionWorkspacePath(session.workspacePath),
      };
      exec(
        `INSERT OR REPLACE INTO sessions (id, threadId, title, workspacePath, model, permission, activeGoalObjective, status, createdAt, updatedAt, contextUsagePct, contextUsageTokens, contextWindow)
         VALUES (@id, @threadId, @title, @workspacePath, @model, @permission, @activeGoalObjective, @status, @createdAt, @updatedAt, @contextUsagePct, @contextUsageTokens, @contextWindow)`,
        normalized,
      );
    }
    for (const [, messages] of parsed.messages ?? []) {
      for (const message of messages) {
        exec(
          `INSERT OR REPLACE INTO messages (id, sessionId, runId, role, content, createdAt, status)
           VALUES (@id, @sessionId, @runId, @role, @content, @createdAt, @status)`,
          message,
        );
      }
    }
    for (const [, events] of parsed.events ?? []) {
      for (const event of events) {
        exec(
          `INSERT OR REPLACE INTO events (id, sessionId, runId, messageId, type, timestamp, payloadJson)
           VALUES (@id, @sessionId, @runId, @messageId, @type, @timestamp, @payloadJson)`,
          {
            id: event.id,
            sessionId: event.sessionId,
            runId: event.runId ?? null,
            messageId: event.messageId ?? null,
            type: event.type,
            timestamp: event.timestamp,
            payloadJson: JSON.stringify(event.payload ?? {}),
          },
        );
      }
    }
  });
  tx();
}

function defaultWorkspacePath() {
  return process.env.DEFAULT_WORKSPACE_PATH || readFcodeProjects()[0]?.path || workspaceDir;
}

function normalizeSessionWorkspacePath(value: string) {
  const input = String(value || "").replace(/\//g, "\\");
  const legacyWorkspaceSegment = ["", ".f", "code", "workspace"].join("\\");
  const fallback = defaultWorkspacePath();
  if (!input) return fallback;
  if (input.toLowerCase().includes(legacyWorkspaceSegment)) return fallback;
  return input;
}

export function engineWorkspacePath() {
  return defaultWorkspacePath();
}

export function engineHomePath() {
  return fencodeHomeDir;
}

function initializeFencodeHome() {
  hydrateFromSeed();
  fs.mkdirSync(fencodeHomeDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(defaultWorkspacePath(), { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  const normalized = normalizeFcodeConfig(readConfigJson());
  fs.writeFileSync(configFile, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

function hydrateFromSeed() {
  if (!fs.existsSync(seedDir)) return;
  copyMissingRecursive(seedDir, fencodeHomeDir);
}

function copyMissingRecursive(fromDir: string, toDir: string) {
  fs.mkdirSync(toDir, { recursive: true });
  for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
    const fromPath = path.join(fromDir, entry.name);
    const toPath = path.join(toDir, entry.name);
    if (entry.isDirectory()) {
      copyMissingRecursive(fromPath, toPath);
      continue;
    }
    if (!fs.existsSync(toPath)) {
      fs.mkdirSync(path.dirname(toPath), { recursive: true });
      fs.copyFileSync(fromPath, toPath);
    }
  }
}

function useDb() {
  return ensureDatabase();
}

function query<T>(sql: string, params: unknown[] = []) {
  return useDb().prepare(sql).get(...params) as T;
}

function all<T>(sql: string, params: unknown[] = []) {
  return useDb().prepare(sql).all(...params) as T[];
}

function exec(sql: string, params: unknown[] | Record<string, unknown> = []) {
  const statement = useDb().prepare(sql);
  if (Array.isArray(params)) {
    statement.run(...params);
    return;
  }
  statement.run(params);
}

function readConfigJson() {
  if (!fs.existsSync(configFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(configFile, "utf8")) as Partial<FcodeConfig>;
  } catch {
    return {};
  }
}

function normalizeFcodeConfig(input: Partial<FcodeConfig>): FcodeConfig {
  const provider = (input.provider ?? {}) as Partial<FcodeConfig["provider"]>;
  const providerId = String(input.modelProvider || provider.id || "9router").trim();
  return {
    version: Number(input.version || 1),
    createdAt: input.createdAt || nowIso(),
    modelProvider: providerId,
    model: String(input.model || "gpt-5.5").trim(),
    personality: String(input.personality || "pragmatic").trim(),
    reasoningEffort: String(input.reasoningEffort || "medium").trim(),
    instructions: String(input.instructions || ""),
    features: {
      memories: input.features?.memories ?? true,
      allowGlobalScan: input.features?.allowGlobalScan ?? false,
    },
    provider: {
      id: providerId,
      name: String(provider.name || "9Router").trim(),
      baseUrl: String(provider.baseUrl || "http://127.0.0.1:20128/v1").trim(),
      wireApi: String(provider.wireApi || "responses").trim(),
    },
    engineServerUrl: String(input.engineServerUrl || "http://127.0.0.1:32188").trim(),
    subagentModel: String(input.subagentModel || "").trim(),
    projects: normalizeProjects(input.projects ?? []),
    storage: {
      home: fencodeHomeDir,
      db: sqliteFile,
      workspace: workspaceDir,
      skills: skillsDir,
      ...input.storage,
    },
  };
}

function readFcodeProjects() {
  return normalizeProjects(readConfigJson().projects ?? []);
}

function normalizeProjects(projects: Array<{ path: string; trustLevel?: string }>) {
  const seen = new Set<string>();
  const output: Array<{ path: string; trustLevel: string }> = [];
  for (const project of projects) {
    const projectPath = String(project.path || "").trim().replace(/\//g, "\\").replace(/\\+$/, "");
    const key = projectPath.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push({ path: projectPath, trustLevel: String(project.trustLevel || "trusted").trim() || "trusted" });
  }
  return output;
}

function safeParseJson(value: string) {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}
