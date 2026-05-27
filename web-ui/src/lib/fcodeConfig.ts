import fs from "node:fs";
import path from "node:path";
import { resolveFencodeHome } from "./runtimeHome";

export type FcodeProviderConfig = {
  id: string;
  name: string;
  baseUrl: string;
  wireApi: string;
};

export type FcodeConfigView = {
  path: string;
  exists: boolean;
  raw: string;
  modelProvider: string;
  model: string;
  personality: string;
  reasoningEffort: string;
  instructions: string;
  memories: boolean;
  allowGlobalScan: boolean;
  provider: FcodeProviderConfig;
  engineServerUrl: string;
  subagentModel: string;
};

export type FcodeConfigPatch = Omit<FcodeConfigView, "path" | "exists" | "raw" | "provider"> & {
  provider: FcodeProviderConfig;
};

export type ConfigEdit = {
  keyPath: string;
  value: string | boolean | number | null;
  mergeStrategy: "replace" | "upsert";
};

export type FcodeWorkspaceProject = {
  path: string;
  trustLevel: string;
};

type PersistedConfig = {
  version: number;
  createdAt: string;
  modelProvider: string;
  model: string;
  personality: string;
  reasoningEffort: string;
  instructions: string;
  features: { memories: boolean; allowGlobalScan: boolean };
  provider: FcodeProviderConfig;
  engineServerUrl: string;
  subagentModel: string;
  projects: FcodeWorkspaceProject[];
};

const DEFAULT_PROVIDER: FcodeProviderConfig = {
  id: "9router",
  name: "9Router",
  baseUrl: "http://127.0.0.1:20128/v1",
  wireApi: "responses",
};

function fencodeHome() {
  return resolveFencodeHome();
}

function configFilePath() {
  return path.join(fencodeHome(), "config.json");
}

export function fcodeConfigPath() {
  initializeConfig();
  return configFilePath();
}

export function readFcodeConfig(): FcodeConfigView {
  const persisted = readPersistedConfig();
  const configPath = configFilePath();
  return {
    path: configPath,
    exists: fs.existsSync(configPath),
    raw: JSON.stringify(persisted, null, 2),
    modelProvider: persisted.modelProvider,
    model: persisted.model,
    personality: persisted.personality,
    reasoningEffort: persisted.reasoningEffort,
    instructions: persisted.instructions,
    memories: persisted.features.memories,
    allowGlobalScan: persisted.features.allowGlobalScan,
    provider: persisted.provider,
    engineServerUrl: persisted.engineServerUrl,
    subagentModel: persisted.subagentModel,
  };
}

export function writeFcodeConfig(input: FcodeConfigPatch) {
  const current = readPersistedConfig();
  const providerId = input.provider.id.trim() || input.modelProvider.trim() || DEFAULT_PROVIDER.id;
  const next: PersistedConfig = {
    ...current,
    modelProvider: providerId,
    model: input.model.trim(),
    personality: input.personality.trim(),
    reasoningEffort: input.reasoningEffort.trim(),
    instructions: input.instructions,
    features: { memories: input.memories, allowGlobalScan: input.allowGlobalScan },
    provider: {
      id: providerId,
      name: input.provider.name.trim(),
      baseUrl: input.provider.baseUrl.trim(),
      wireApi: input.provider.wireApi.trim(),
    },
    engineServerUrl: input.engineServerUrl.trim(),
    subagentModel: input.subagentModel.trim(),
    projects: current.projects,
  };
  writePersistedConfig(next);
  return readFcodeConfig();
}

export function writeRawFcodeConfig(raw: string) {
  const parsed = JSON.parse(raw) as Partial<PersistedConfig>;
  const current = readPersistedConfig();
  const next: PersistedConfig = {
    ...current,
    ...parsed,
    features: {
      memories: parsed.features?.memories ?? current.features.memories,
      allowGlobalScan: parsed.features?.allowGlobalScan ?? current.features.allowGlobalScan,
    },
    provider: {
      id: parsed.provider?.id ?? current.provider.id,
      name: parsed.provider?.name ?? current.provider.name,
      baseUrl: parsed.provider?.baseUrl ?? current.provider.baseUrl,
      wireApi: parsed.provider?.wireApi ?? current.provider.wireApi,
    },
    engineServerUrl: parsed.engineServerUrl ?? current.engineServerUrl,
    // Workspace list is managed via dedicated workspace settings endpoints.
    // Keep current projects to avoid stale raw editor state replacing entries.
    projects: current.projects,
  };
  writePersistedConfig(next);
  return readFcodeConfig();
}

export function toConfigEdits(input: FcodeConfigPatch): ConfigEdit[] {
  return [
    edit("modelProvider", input.modelProvider),
    edit("model", input.model),
    edit("personality", input.personality),
    edit("reasoningEffort", input.reasoningEffort),
    edit("instructions", input.instructions),
    edit("features.memories", input.memories),
    edit("features.allowGlobalScan", input.allowGlobalScan),
    edit("provider.id", input.provider.id),
    edit("provider.name", input.provider.name),
    edit("provider.baseUrl", input.provider.baseUrl),
    edit("provider.wireApi", input.provider.wireApi),
    edit("engineServerUrl", input.engineServerUrl),
    edit("subagentModel", input.subagentModel),
  ];
}

export function listFcodeWorkspaceProjects(): FcodeWorkspaceProject[] {
  return readPersistedConfig().projects;
}

export function addFcodeWorkspaceProject(projectPath: string, trustLevel = "trusted") {
  const current = readPersistedConfig();
  const normalizedPath = normalizeWorkspacePath(projectPath);
  if (!normalizedPath) return current.projects;
  if (current.projects.some((project) => sameWorkspacePath(project.path, normalizedPath))) return current.projects;
  const projects = dedupeProjects([...current.projects, { path: normalizedPath, trustLevel: trustLevel.trim() || "trusted" }]);
  writePersistedConfig({ ...current, projects });
  return projects;
}

export function removeFcodeWorkspaceProject(projectPath: string) {
  const current = readPersistedConfig();
  const normalizedPath = normalizeWorkspacePath(projectPath);
  const projects = current.projects.filter((project) => !sameWorkspacePath(project.path, normalizedPath));
  writePersistedConfig({ ...current, projects });
  return projects;
}

function edit(keyPath: string, value: string | boolean): ConfigEdit {
  return { keyPath, value, mergeStrategy: "upsert" };
}

function initializeConfig() {
  const configPath = configFilePath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (fs.existsSync(configPath)) return;
  writePersistedConfig(defaultPersistedConfig());
}

function readPersistedConfig(): PersistedConfig {
  const configPath = configFilePath();
  initializeConfig();
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as PersistedConfig;
    return normalizePersistedConfig(parsed);
  } catch {
    const fallback = defaultPersistedConfig();
    writePersistedConfig(fallback);
    return fallback;
  }
}

function writePersistedConfig(config: PersistedConfig) {
  const configPath = configFilePath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(normalizePersistedConfig(config), null, 2)}\n`, "utf8");
}

function normalizePersistedConfig(input: PersistedConfig): PersistedConfig {
  return {
    version: Number(input.version || 1),
    createdAt: input.createdAt || new Date().toISOString(),
    modelProvider: (input.modelProvider || input.provider?.id || DEFAULT_PROVIDER.id).trim(),
    model: (input.model || "gpt-5.5").trim(),
    personality: (input.personality || "pragmatic").trim(),
    reasoningEffort: (input.reasoningEffort || "medium").trim(),
    instructions: input.instructions || "",
    features: {
      memories: input.features?.memories ?? true,
      allowGlobalScan: input.features?.allowGlobalScan ?? false,
    },
    provider: {
      id: (input.provider?.id || DEFAULT_PROVIDER.id).trim(),
      name: (input.provider?.name || DEFAULT_PROVIDER.name).trim(),
      baseUrl: (input.provider?.baseUrl || DEFAULT_PROVIDER.baseUrl).trim(),
      wireApi: (input.provider?.wireApi || DEFAULT_PROVIDER.wireApi).trim(),
    },
    engineServerUrl: (input.engineServerUrl || "http://127.0.0.1:32188").trim(),
    subagentModel: (input.subagentModel || "").trim(),
    projects: dedupeProjects(Array.isArray(input.projects) ? input.projects : []),
  };
}

function defaultPersistedConfig(): PersistedConfig {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    modelProvider: DEFAULT_PROVIDER.id,
    model: "gpt-5.5",
    personality: "pragmatic",
    reasoningEffort: "medium",
    instructions: "",
    features: { memories: true, allowGlobalScan: false },
    provider: DEFAULT_PROVIDER,
    engineServerUrl: "http://127.0.0.1:32188",
    subagentModel: "",
    projects: [],
  };
}

function dedupeProjects(projects: FcodeWorkspaceProject[]) {
  const seen = new Set<string>();
  const output: FcodeWorkspaceProject[] = [];
  for (const project of projects) {
    const normalized = normalizeWorkspacePath(project.path);
    const key = normalized.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push({ path: normalized, trustLevel: (project.trustLevel || "trusted").trim() });
  }
  return output;
}

function normalizeWorkspacePath(value: string) {
  return value.trim().replace(/\//g, "\\").replace(/\\+$/, "");
}

function sameWorkspacePath(left: string, right: string) {
  return normalizeWorkspacePath(left).toLowerCase() === normalizeWorkspacePath(right).toLowerCase();
}
