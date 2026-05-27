import { makeId, nowIso } from "./id";
import { cleanDisplayText } from "./text";
import { addFcodeWorkspaceProject, listFcodeWorkspaceProjects, removeFcodeWorkspaceProject } from "./fcodeConfig";
import fs from "node:fs";
import path from "node:path";
import { resolveFencodeHome } from "./runtimeHome";
import type { AgentEvent } from "@/types/events";
import type { Message, Session, SessionDetail } from "@/types/session";

type Database = {
  sessions: Map<string, Session>;
  messages: Map<string, Message[]>;
  events: Map<string, AgentEvent[]>;
  models: Map<string, ModelConfig>;
  personas: Map<string, PersonaConfig>;
  skills: Map<string, SkillConfig>;
  workspaces: Map<string, WorkspaceConfig>;
  mcpServers: Map<string, McpServerConfig>;
  authSettings: AuthSettings;
  permissionSettings: PermissionSettings;
  imageGenSettings: ImageGenSettings;
};

type PersistedDatabase = {
  sessions: Session[];
  messages: Array<[string, Message[]]>;
  events: Array<[string, AgentEvent[]]>;
  models: ModelConfig[];
  personas: PersonaConfig[];
  skills: SkillConfig[];
  workspaces: WorkspaceConfig[];
  mcpServers: McpServerConfig[];
  authSettings: AuthSettings;
  permissionSettings: PermissionSettings;
  imageGenSettings: ImageGenSettings;
};

const globalDb = globalThis as typeof globalThis & {
  __fcodeDb?: Database;
  __fcodeSaveTimer?: ReturnType<typeof setTimeout>;
};

const OLD_DEFAULT_WORKSPACE = "D:\\1aiagent-coding";

function engineHome() {
  return resolveFencodeHome();
}

function dbFilePath() {
  return path.join(engineHome(), "data", "fcode-v2-db.json");
}

export type ModelConfig = { id: string; name: string; baseUrl?: string; apiKey?: string; contextWindow: number; inputModalities?: string[]; createdAt: string };
export type PersonaConfig = { id: string; name: string; prompt: string; temperature: number; createdAt: string };
export type SkillConfig = { id: string; name: string; description: string; instructions: string; trigger: string; enabled: boolean; createdAt: string };
export type WorkspaceConfig = { id: string; label: string; path: string; createdAt: string };
export type McpServerConfig = { id: string; name: string; transport: "stdio" | "sse"; command?: string; url?: string; status: "connected" | "disconnected" | "error"; createdAt: string };
export type AuthSettings = { mode: "api-key" | "oauth"; apiKeys: Array<{ id: string; name: string; masked: string; createdAt: string }> };
export type PermissionSettings = { level: "ask-always" | "ask-risky" | "auto-approve"; allowList: string[]; blockList: string[] };
export type ImageGenSettings = { selectedModel: string; models: string[] };

export function db() {
  if (!globalDb.__fcodeDb) {
    globalDb.__fcodeDb = loadDatabase();
  }
  globalDb.__fcodeDb.models ??= new Map(seedModels().map((model) => [model.id, model]));
  globalDb.__fcodeDb.personas ??= new Map(seedPersonas().map((persona) => [persona.id, persona]));
  globalDb.__fcodeDb.skills ??= new Map(seedSkills().map((skill) => [skill.id, skill]));
  globalDb.__fcodeDb.workspaces ??= new Map(seedWorkspaces().map((workspace) => [workspace.id, workspace]));
  globalDb.__fcodeDb.mcpServers ??= new Map();
  globalDb.__fcodeDb.authSettings ??= { mode: "api-key", apiKeys: [] };
  globalDb.__fcodeDb.permissionSettings ??= { level: "ask-risky", allowList: [], blockList: [] };
  globalDb.__fcodeDb.imageGenSettings ??= seedImageGenSettings();
  return globalDb.__fcodeDb;
}

function loadDatabase(): Database {
  const dbFile = dbFilePath();
  if (fs.existsSync(dbFile)) {
    try {
      const persisted = JSON.parse(fs.readFileSync(dbFile, "utf8")) as PersistedDatabase;
      const defaultPath = defaultWorkspacePath();
      return {
        sessions: new Map((persisted.sessions ?? []).map((session) => [
          session.id,
          {
            ...session,
            title: sanitizeSessionTitle(session.title),
            workspacePath: normalizeSessionWorkspacePath(session.workspacePath, defaultPath),
          },
        ])),
        messages: new Map(persisted.messages ?? []),
        events: new Map(persisted.events ?? []),
        models: new Map((persisted.models?.length ? persisted.models : seedModels()).map((model) => {
          const normalized = normalizeModel(model);
          return [normalized.id, normalized];
        })),
        personas: new Map((persisted.personas?.length ? persisted.personas : seedPersonas()).map((persona) => [persona.id, persona])),
        skills: new Map((persisted.skills?.length ? persisted.skills : seedSkills()).map((skill) => [skill.id, skill])),
        workspaces: new Map(normalizeWorkspaces(persisted.workspaces?.length ? persisted.workspaces : seedWorkspaces()).map((workspace) => [workspace.id, workspace])),
        mcpServers: new Map((persisted.mcpServers ?? []).map((server) => [server.id, server])),
        authSettings: persisted.authSettings ?? { mode: "api-key", apiKeys: [] },
        permissionSettings: persisted.permissionSettings ?? { level: "ask-risky", allowList: [], blockList: [] },
        imageGenSettings: normalizeImageGenSettings(persisted.imageGenSettings),
      };
    } catch {
      // Fall through to a clean seed if the local JSON is unreadable.
    }
  }

  const session = seedSession();
  return {
    sessions: new Map([[session.id, session]]),
    messages: new Map([[session.id, []]]),
    events: new Map([[session.id, []]]),
    models: new Map(seedModels().map((model) => [model.id, normalizeModel(model)])),
    personas: new Map(seedPersonas().map((persona) => [persona.id, persona])),
    skills: new Map(seedSkills().map((skill) => [skill.id, skill])),
    workspaces: new Map(seedWorkspaces().map((workspace) => [workspace.id, workspace])),
    mcpServers: new Map(),
    authSettings: { mode: "api-key", apiKeys: [] },
    permissionSettings: { level: "ask-risky", allowList: [], blockList: [] },
    imageGenSettings: seedImageGenSettings(),
  };
}

function scheduleSave() {
  if (globalDb.__fcodeSaveTimer) clearTimeout(globalDb.__fcodeSaveTimer);
  globalDb.__fcodeSaveTimer = setTimeout(saveDatabase, 150);
}

function saveDatabase() {
  const store = globalDb.__fcodeDb;
  if (!store) return;
  const dbFile = dbFilePath();
  const persisted: PersistedDatabase = {
    sessions: [...store.sessions.values()],
    messages: [...store.messages.entries()],
    events: [...store.events.entries()].map(([sessionId, events]) => [sessionId, events.slice(-1000)]),
    models: [...store.models.values()],
    personas: [...store.personas.values()],
    skills: [...store.skills.values()],
    workspaces: [...store.workspaces.values()],
    mcpServers: [...store.mcpServers.values()],
    authSettings: store.authSettings,
    permissionSettings: store.permissionSettings,
    imageGenSettings: store.imageGenSettings,
  };
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  fs.writeFileSync(dbFile, JSON.stringify(persisted, null, 2));
}

function seedSession(): Session {
  const timestamp = nowIso();
  return {
    id: "demo",
    title: "FCode V2 SSE demo",
    workspacePath: defaultWorkspacePath(),
    model: "gpt-5.5",
    permission: "workspace-write",
    contextUsagePct: 0,
    contextUsageTokens: 0,
    contextWindow: 256000,
    status: "idle",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function listSessions() {
  return [...db().sessions.values()]
    .map((session) => ({ ...session, title: sanitizeSessionTitle(session.title) || "New chat" }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function findSessionIdByThreadId(threadId: string) {
  for (const session of db().sessions.values()) {
    if (session.threadId === threadId) return session.id;
  }
  return null;
}

function seedModels(): ModelConfig[] {
  const configured = readFcodeModels();
  if (configured.length) return configured;
  const timestamp = nowIso();
  return [
    { id: "gpt-5.5", name: "GPT-5.5", contextWindow: 256000, inputModalities: ["text"], createdAt: timestamp },
    { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", contextWindow: 128000, inputModalities: ["text"], createdAt: timestamp },
  ];
}

function readFcodeModels(): ModelConfig[] {
  const file = path.join(engineHome(), "models.toml");
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const parsed: Array<ModelConfig | null> = text
    .split(/\[\[models\]\]/)
    .map((chunk) => {
      const id = chunk.match(/\bid\s*=\s*"([^"]+)"/)?.[1];
      const name = chunk.match(/\bname\s*=\s*"([^"]+)"/)?.[1];
      const context = Number(chunk.match(/\bcontext_window\s*=\s*(\d+)/)?.[1] ?? 128000);
      if (!id || !name) return null;
      return { id, name, contextWindow: context, inputModalities: ["text"], createdAt: nowIso() } satisfies ModelConfig;
    });
  return parsed.filter((model): model is ModelConfig => model !== null);
}

function seedPersonas(): PersonaConfig[] {
  return [{ id: "default", name: "Fennai", prompt: "Professional coding agent. Concise, clear, safe.", temperature: 0.3, createdAt: nowIso() }];
}

function seedSkills(): SkillConfig[] {
  return [];
}

function seedWorkspaces(): WorkspaceConfig[] {
  const path = defaultWorkspacePath();
  return [{ id: "default", label: path.split(/[\\/]/).at(-1) || "workspace", path, createdAt: nowIso() }];
}

function defaultWorkspacePath() {
  const workspacePath = process.env.DEFAULT_WORKSPACE_PATH ?? path.join(engineHome(), "workspace");
  fs.mkdirSync(workspacePath, { recursive: true });
  return workspacePath;
}

function normalizeSessionWorkspacePath(value: string, fallbackPath: string) {
  const normalized = normalizeWorkspacePath(value || "");
  const legacyWorkspaceSegment = ["", ".f", "code", "workspace"].join("\\");
  if (!normalized) return fallbackPath;
  if (normalized === normalizeWorkspacePath(OLD_DEFAULT_WORKSPACE)) return fallbackPath;
  if (normalized.toLowerCase().includes(legacyWorkspaceSegment)) return fallbackPath;
  return normalized;
}

function normalizeWorkspaces(workspaces: WorkspaceConfig[]) {
  const defaultPath = defaultWorkspacePath();
  const projects = listFcodeWorkspaceProjects();
  const source = projects.length
    ? projects.map((project, index) => ({
      id: `config-${index}-${workspaceIdFromPath(project.path)}`,
      label: workspaceLabel(project.path),
      path: project.path,
      createdAt: nowIso(),
    }))
    : workspaces;
  return dedupeWorkspaces(source.map((workspace) => {
    const nextPath = workspace.path === OLD_DEFAULT_WORKSPACE ? defaultPath : normalizeWorkspacePath(workspace.path);
    return { ...workspace, label: workspace.label || workspaceLabel(nextPath), path: nextPath };
  }));
}

export function createSession(input?: Partial<Pick<Session, "title" | "workspacePath" | "model" | "permission">>) {
  const latest = listSessions()[0];
  const workspaces = listWorkspaces();
  const latestWorkspace = latest?.workspacePath && workspaces.some((workspace) => sameWorkspacePath(workspace.path, latest.workspacePath))
    ? latest.workspacePath
    : undefined;
  const timestamp = nowIso();
  const model = input?.model || latest?.model || "gpt-5.5";
  const session: Session = {
    id: makeId("ses"),
    title: input?.title || "New chat",
    workspacePath: input?.workspacePath || latestWorkspace || workspaces[0]?.path || defaultWorkspacePath(),
    model,
    permission: input?.permission || latest?.permission || "workspace-write",
    contextUsagePct: 0,
    contextUsageTokens: 0,
    contextWindow: getModelContextWindow(model),
    status: "idle",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  db().sessions.set(session.id, session);
  db().messages.set(session.id, []);
  db().events.set(session.id, []);
  scheduleSave();
  return session;
}

export function getSession(id: string): SessionDetail | null {
  const store = db();
  const session = store.sessions.get(id);
  if (!session) return null;
  const usage = estimateSessionContextUsage(id, session.model);
  return {
    session: {
      ...session,
      title: sanitizeSessionTitle(session.title) || "New chat",
      contextUsagePct: usage.usagePct,
      contextUsageTokens: usage.usedTokens,
      contextWindow: usage.contextWindow,
    },
    messages: store.messages.get(id) ?? [],
    events: store.events.get(id) ?? [],
  };
}

export function patchSession(id: string, patch: Partial<Session>) {
  const store = db();
  const current = store.sessions.get(id);
  if (!current) return null;
  const nextModel = patch.model ?? current.model;
  const normalizedPatch = patch.workspacePath ? { ...patch, workspacePath: normalizeWorkspacePath(patch.workspacePath) } : patch;
  const next = {
    ...current,
    ...normalizedPatch,
    contextWindow: patch.contextWindow ?? getModelContextWindow(nextModel),
    updatedAt: nowIso(),
  };
  store.sessions.set(id, next);
  scheduleSave();
  return next;
}

export function deleteSession(id: string) {
  const store = db();
  store.sessions.delete(id);
  store.messages.delete(id);
  store.events.delete(id);
  scheduleSave();
}

export function addMessage(message: Message) {
  const store = db();
  const currentMessages = store.messages.get(message.sessionId) ?? [];
  const nextMessage = { ...message, content: cleanDisplayText(message.content) };
  store.messages.set(message.sessionId, [...currentMessages, nextMessage]);
  const currentSession = store.sessions.get(message.sessionId);
  const hasUserMessage = currentMessages.some((entry) => entry.role === "user");
  const shouldSetInitialTitle = Boolean(
    nextMessage.role === "user" &&
    currentSession &&
    isDefaultSessionTitle(currentSession.title) &&
    !hasUserMessage,
  );
  patchSession(message.sessionId, shouldSetInitialTitle ? { updatedAt: nowIso(), title: makeSessionTitle(nextMessage.content) } : { updatedAt: nowIso() });
  refreshSessionMemory(message.sessionId);
  scheduleSave();
  return nextMessage;
}

function isDefaultSessionTitle(title: string) {
  return title === "New chat" || title === "FCode V2 SSE demo";
}

function makeSessionTitle(content: string) {
  const clean = sanitizeSessionTitle(content);
  return clean.slice(0, 64) || "New chat";
}

function sanitizeSessionTitle(title: string) {
  return cleanDisplayText(title)
    .replace(/!\[[^\]]*]\([^)]*\)/g, "image")
    .replace(/\[([^\]]+)]\(fcode-mention:\/\/[^)]*\)/g, "$1")
    .replace(/\[([^\]]+)]\(fcode-mention:\/\/.*$/g, "$1")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/\[mention:[^\]]+]/g, "")
    .replace(/[#*_`>~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function updateMessage(sessionId: string, messageId: string, patch: Partial<Message>) {
  const store = db();
  const nextPatch = patch.content ? { ...patch, content: cleanDisplayText(patch.content) } : patch;
  const next = (store.messages.get(sessionId) ?? []).map((message) =>
    message.id === messageId ? { ...message, ...nextPatch } : message,
  );
  store.messages.set(sessionId, next);
  if (patch.status && patch.status !== "streaming") refreshSessionMemory(sessionId);
  scheduleSave();
}

export function addEvent(event: AgentEvent) {
  const store = db();
  const current = store.events.get(event.sessionId) ?? [];
  store.events.set(event.sessionId, [...current, event].slice(-1000));
  if (shouldEventRefreshMemory(event)) refreshSessionMemory(event.sessionId);
  scheduleSave();
  return event;
}

function shouldEventRefreshMemory(event: AgentEvent) {
  return event.type !== "heartbeat" &&
    event.type !== "message.delta" &&
    event.type !== "cmd.output" &&
    event.type !== "thinking.delta";
}

export function refreshSessionMemory(sessionId: string) {
  const store = db();
  const session = store.sessions.get(sessionId);
  if (!session) return null;
  const messages = store.messages.get(sessionId) ?? [];
  const events = store.events.get(sessionId) ?? [];
  const facts = deriveSessionFacts(session, messages, events);
  const summary = deriveSessionSummary(session, messages, events, facts);
  const next = {
    ...session,
    sessionFacts: facts,
    sessionSummary: summary,
    updatedAt: nowIso(),
  };
  store.sessions.set(sessionId, next);
  return next;
}

function deriveSessionFacts(session: Session, _messages: Message[], events: AgentEvent[]) {
  const facts: string[] = [];
  const installedSkills = new Set<string>();
  for (const skill of listSkills()) {
    if (skill.enabled) installedSkills.add(skill.name);
  }
  if (installedSkills.size) facts.push(`Installed skills: ${[...installedSkills].join(", ")}`);

  const touchedFiles = new Set<string>();
  for (const event of events) {
    const payload = event.payload as { path?: string; oldPath?: string; newPath?: string; message?: string; tool?: string };
    if (payload.path) touchedFiles.add(payload.path);
    if (payload.newPath) touchedFiles.add(payload.newPath);
    if (payload.oldPath) touchedFiles.add(payload.oldPath);
  }
  if (touchedFiles.size) facts.push(`Touched files: ${[...touchedFiles].slice(-8).join(", ")}`);

  const lastError = [...events].reverse().find((event) => event.type === "session.error" || event.type.endsWith(".error"));
  if (lastError) facts.push(`Last error: ${String((lastError.payload as { message?: string }).message ?? lastError.type)}`);

  const lastSearch = [...events].reverse().find((event) => event.type.startsWith("web.search"));
  if (lastSearch) {
    const payload = lastSearch.payload as { query?: string };
    if (payload.query) facts.push(`Last web search: ${payload.query}`);
  }

  facts.push(`Workspace: ${session.workspacePath}`);
  facts.push(`Model: ${session.model}`);
  facts.push(`Permission: ${session.permission}`);
  return [...new Set(facts)].slice(0, 12);
}

function deriveSessionSummary(session: Session, messages: Message[], events: AgentEvent[], facts: string[]) {
  const recentUsers = messages.filter((message) => message.role === "user").slice(-4).map((message) => trimSummaryLine(message.content, 180));
  const recentAssistant = messages.filter((message) => message.role === "assistant").slice(-2).map((message) => trimSummaryLine(message.content, 180));
  const recentEvents = events
    .filter((event) => event.type !== "heartbeat" && event.type !== "message.delta" && event.type !== "cmd.output")
    .slice(-6)
    .map((event) => `${event.type}: ${trimSummaryLine(JSON.stringify(event.payload), 140)}`);
  return [
    `Session ${session.id} on ${session.workspacePath}`,
    facts.length ? `Facts: ${facts.join(" | ")}` : "",
    recentUsers.length ? `Recent user goals: ${recentUsers.join(" || ")}` : "",
    recentAssistant.length ? `Recent assistant output: ${recentAssistant.join(" || ")}` : "",
    recentEvents.length ? `Recent events: ${recentEvents.join(" || ")}` : "",
  ].filter(Boolean).join("\n");
}

function trimSummaryLine(value: string, max: number) {
  const clean = cleanDisplayText(value).replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

export function listModels() {
  return [...db().models.values()].map(normalizeModel);
}

export function getModelContextWindow(modelId: string) {
  const model = db().models.get(modelId);
  if (model?.contextWindow && model.contextWindow > 0) return model.contextWindow;
  return 128000;
}

export function estimateSessionContextUsage(sessionId: string, modelId: string) {
  const store = db();
  const session = store.sessions.get(sessionId);
  if (!session) return { usedTokens: 0, contextWindow: getModelContextWindow(modelId), usagePct: 0 };
  const summary = session.compactSummary ?? "";
  const messageText = (store.messages.get(sessionId) ?? []).map((message) => `${message.role}: ${message.content}`).join("\n");
  const eventText = (store.events.get(sessionId) ?? [])
    .slice(-320)
    .map((event) => `${event.type} ${JSON.stringify(event.payload)}`)
    .join("\n");
  const joined = [summary, messageText, eventText].filter(Boolean).join("\n\n");
  const usedTokens = Math.max(1, Math.ceil(joined.length / 4));
  const contextWindow = getModelContextWindow(modelId);
  const usagePct = Math.max(0, Math.min(100, Math.round((usedTokens / contextWindow) * 100)));
  return { usedTokens, contextWindow, usagePct };
}

export function compactSessionContext(sessionId: string, mode: "manual" | "auto" = "manual") {
  const detail = getSession(sessionId);
  if (!detail) return null;
  const messages = detail.messages;
  const cut = Math.max(0, messages.length - 12);
  const older = messages.slice(0, cut);
  if (!older.length) {
    const usage = estimateSessionContextUsage(sessionId, detail.session.model);
    return patchSession(sessionId, {
      contextUsagePct: usage.usagePct,
      contextUsageTokens: usage.usedTokens,
      contextWindow: usage.contextWindow,
    });
  }
  const lines = older.slice(-32).map((message) => {
    const role = message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user";
    const text = cleanDisplayText(message.content).replace(/\s+/g, " ").trim().slice(0, 280);
    return `- ${role}: ${text}`;
  });
  const summary = [
    `Context compact (${mode})`,
    `Time: ${nowIso()}`,
    `Session: ${detail.session.id}`,
    "",
    ...lines,
  ].join("\n").slice(0, 12000);
  const next = patchSession(sessionId, {
    compactSummary: summary,
    compactedAt: nowIso(),
  });
  if (!next) return null;
  const usage = estimateSessionContextUsage(sessionId, next.model);
  return patchSession(sessionId, {
    contextUsagePct: usage.usagePct,
    contextUsageTokens: usage.usedTokens,
    contextWindow: usage.contextWindow,
  });
}

export function upsertModel(input: Partial<ModelConfig> & { name: string }) {
  const model = normalizeModel({
    id: input.id || makeId("model"),
    name: input.name,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    contextWindow: input.contextWindow || 128000,
    inputModalities: input.inputModalities?.length ? input.inputModalities : ["text"],
    createdAt: input.createdAt || nowIso(),
  });
  db().models.set(model.id, model);
  scheduleSave();
  return model;
}

function normalizeModel(model: ModelConfig): ModelConfig {
  const cleanModalities = (model.inputModalities ?? ["text"])
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    ...model,
    contextWindow: model.contextWindow > 0 ? model.contextWindow : 128000,
    inputModalities: cleanModalities.length ? cleanModalities : ["text"],
  };
}

export function deleteModel(id: string) {
  db().models.delete(id);
  scheduleSave();
}

export function listPersonas() {
  return [...db().personas.values()];
}

export function upsertPersona(input: Partial<PersonaConfig> & { name: string; prompt: string }) {
  const persona: PersonaConfig = {
    id: input.id || makeId("persona"),
    name: input.name,
    prompt: input.prompt,
    temperature: input.temperature ?? 0.3,
    createdAt: input.createdAt || nowIso(),
  };
  db().personas.set(persona.id, persona);
  scheduleSave();
  return persona;
}

export function deletePersona(id: string) {
  db().personas.delete(id);
  scheduleSave();
}

export function listSkills() {
  return [...db().skills.values()];
}

export function upsertSkill(input: Partial<SkillConfig> & { name: string; description: string; instructions: string }) {
  const triggerRaw = (input.trigger || input.name).trim().toLowerCase();
  const trigger = triggerRaw.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const existing = input.id
    ? undefined
    : [...db().skills.values()].find((skill) => skill.trigger === (trigger || "skill"));
  const skill: SkillConfig = {
    id: input.id || existing?.id || makeId("skill"),
    name: input.name.trim(),
    description: input.description.trim(),
    instructions: input.instructions.trim(),
    trigger: trigger || "skill",
    enabled: input.enabled ?? true,
    createdAt: input.createdAt || existing?.createdAt || nowIso(),
  };
  db().skills.set(skill.id, skill);
  scheduleSave();
  return skill;
}

export function deleteSkill(id: string) {
  db().skills.delete(id);
  scheduleSave();
}

export function listWorkspaces() {
  syncWorkspacesFromConfig();
  return [...db().workspaces.values()];
}

export function upsertWorkspace(input: Partial<WorkspaceConfig> & { path: string; label?: string }) {
  addFcodeWorkspaceProject(input.path);
  syncWorkspacesFromConfig();
  const existing = [...db().workspaces.values()].find((workspace) => sameWorkspacePath(workspace.path, input.path));
  if (existing) return existing;
  const normalizedPath = normalizeWorkspacePath(input.path);
  const workspace: WorkspaceConfig = {
    id: input.id || makeId("workspace"),
    label: input.label || workspaceLabel(normalizedPath),
    path: normalizedPath,
    createdAt: input.createdAt || nowIso(),
  };
  db().workspaces.set(workspace.id, workspace);
  scheduleSave();
  return workspace;
}

export function deleteWorkspace(id: string) {
  const workspace = db().workspaces.get(id);
  if (workspace) removeFcodeWorkspaceProject(workspace.path);
  db().workspaces.delete(id);
  syncWorkspacesFromConfig();
  scheduleSave();
}

function syncWorkspacesFromConfig() {
  const projects = listFcodeWorkspaceProjects();
  if (!projects.length) {
    const current = dedupeWorkspaces([...db().workspaces.values()]);
    db().workspaces = new Map(current.map((workspace) => [workspace.id, workspace]));
    return;
  }
  const next = projects.map((project, index) => {
    const normalizedPath = normalizeWorkspacePath(project.path);
    return {
      id: `config-${index}-${workspaceIdFromPath(normalizedPath)}`,
      label: workspaceLabel(normalizedPath),
      path: normalizedPath,
      createdAt: nowIso(),
    };
  });
  db().workspaces = new Map(dedupeWorkspaces(next).map((workspace) => [workspace.id, workspace]));
}

function normalizeWorkspacePath(value: string) {
  return value.trim().replace(/\//g, "\\").replace(/\\+$/, "");
}

function sameWorkspacePath(left: string, right: string) {
  return normalizeWorkspacePath(left).toLowerCase() === normalizeWorkspacePath(right).toLowerCase();
}

function workspaceIdFromPath(value: string) {
  return normalizeWorkspacePath(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
}

function workspaceLabel(value: string) {
  return normalizeWorkspacePath(value).split(/[\\/]/).filter(Boolean).at(-1) || "workspace";
}

function dedupeWorkspaces(workspaces: WorkspaceConfig[]) {
  const seen = new Set<string>();
  const output: WorkspaceConfig[] = [];
  for (const workspace of workspaces) {
    const normalizedPath = normalizeWorkspacePath(workspace.path);
    const key = normalizedPath.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push({ ...workspace, label: workspace.label || workspaceLabel(normalizedPath), path: normalizedPath });
  }
  return output;
}

export function listMcpServers() {
  return [...db().mcpServers.values()];
}

export function upsertMcpServer(input: Partial<McpServerConfig> & { name: string; transport: "stdio" | "sse" }) {
  const server: McpServerConfig = {
    id: input.id || makeId("mcp"),
    name: input.name,
    transport: input.transport,
    command: input.command,
    url: input.url,
    status: input.status || "disconnected",
    createdAt: input.createdAt || nowIso(),
  };
  db().mcpServers.set(server.id, server);
  scheduleSave();
  return server;
}

export function deleteMcpServer(id: string) {
  db().mcpServers.delete(id);
  scheduleSave();
}

export function readAuthSettings() {
  return db().authSettings;
}

export function writeAuthSettings(input: Partial<AuthSettings>) {
  db().authSettings = {
    ...db().authSettings,
    ...input,
    apiKeys: input.apiKeys ?? db().authSettings.apiKeys,
  };
  scheduleSave();
  return db().authSettings;
}

export function addApiKey(name: string) {
  const token = `${makeId("key")}-${Math.random().toString(36).slice(2, 10)}`;
  const record = { id: makeId("k"), name, masked: `***${token.slice(-4)}`, createdAt: nowIso() };
  db().authSettings.apiKeys = [...db().authSettings.apiKeys, record];
  scheduleSave();
  return record;
}

export function deleteApiKey(id: string) {
  db().authSettings.apiKeys = db().authSettings.apiKeys.filter((key) => key.id !== id);
  scheduleSave();
}

function seedImageGenSettings(): ImageGenSettings {
  return {
    selectedModel: "cx/gpt-5.5-image",
    models: [
      "cx/gpt-5.5-image",
      "cx/gpt-5.4-image",
      "cx/gpt-5.3-image",
      "cx/gpt-5.2-image",
    ],
  };
}

function normalizeImageGenSettings(input?: ImageGenSettings) {
  const seeded = seedImageGenSettings();
  if (!input) return seeded;
  const models = [...new Set([...(input.models ?? []), ...seeded.models].filter(Boolean))];
  return {
    selectedModel: input.selectedModel && models.includes(input.selectedModel) ? input.selectedModel : models[0],
    models,
  } satisfies ImageGenSettings;
}

export function readImageGenSettings() {
  return normalizeImageGenSettings(db().imageGenSettings);
}

export function writeImageGenSettings(input: Partial<ImageGenSettings>) {
  const current = readImageGenSettings();
  const models = input.models ? [...new Set(input.models.filter(Boolean))] : current.models;
  const selectedModel = input.selectedModel && models.includes(input.selectedModel) ? input.selectedModel : current.selectedModel;
  db().imageGenSettings = normalizeImageGenSettings({ selectedModel, models });
  scheduleSave();
  return db().imageGenSettings;
}

export function readPermissionSettings() {
  return db().permissionSettings;
}

export function writePermissionSettings(input: Partial<PermissionSettings>) {
  db().permissionSettings = {
    ...db().permissionSettings,
    ...input,
    allowList: input.allowList ?? db().permissionSettings.allowList,
    blockList: input.blockList ?? db().permissionSettings.blockList,
  };
  scheduleSave();
  return db().permissionSettings;
}
