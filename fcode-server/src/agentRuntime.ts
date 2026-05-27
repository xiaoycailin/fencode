import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { collectRuntimeSignals, executeTool, type ApprovalRequest, type RuntimeEventSink, type RuntimePreflightMode } from "./runtime/toolExecutor.js";
import { parseToolCall, toolContract } from "./runtime/toolProtocol.js";
import { normalizeToolError, toolNameFor } from "./runtime/toolError.js";
import type { AgentEvent } from "./types.js";
import { permissionSummary, PROVIDER_MAX_RETRIES, PROVIDER_TIMEOUT_MS } from "./runtime/runtimePolicy.js";
import { forceRefreshOauthToken, resolveProviderAuth } from "./runtime/authResolver.js";
import { resolveFencodeHome } from "./runtimeHome.js";

type RuntimeInput = {
  content: string;
  history?: Array<{ role: "user" | "assistant" | "system"; content: string; createdAt?: string }>;
  activity?: AgentEvent[];
  workspacePath: string;
  model: string;
  permission: string;
  signal: AbortSignal;
  sink: RuntimeEventSink;
  requestApproval?: (request: ApprovalRequest) => Promise<"approved" | "rejected">;
};

export type RuntimeResult = {
  objective: { kind: "answer" | "implementation" | "scaffold"; requiresExecution: boolean; label: string };
  progress: { toolActions: number; commandActions: number; writeActions: number };
  success: boolean;
  blockedFinals: number;
};

const MAX_STEPS = 10;

export async function executeAgentRuntime(input: RuntimeInput) {
  const { content, history = [], activity = [], workspacePath, model, permission, signal, sink } = input;
  sink.publish("thinking.start", { message: "Starting fcode-server run" });
  sink.publish("thinking.delta", { message: `Workspace: ${workspacePath}` });
  sink.publish("thinking.delta", { message: `Permission: ${permission}` });

  try {
    const runtimeConfig = readRuntimeConfig();
    const preflightMode = classifyPreflightMode(content);
    const runtimeNotes = await collectRuntimeSignals(workspacePath, sink, preflightMode);
    const memoryContext = runtimeConfig.memories ? readMemoryContext(workspacePath) : "";
    const baseInstructions = buildRuntimeInstructions(workspacePath, permission, runtimeConfig, memoryContext);
    const objective = deriveObjective(content);
    const conversationContext = buildConversationContext(history, content);
    const activityContext = buildActivityContext(activity);
    const progress = { toolActions: 0, commandActions: 0, writeActions: 0 };
    let blockedFinals = 0;
    const transcript: string[] = [
      `Active objective: ${objective.label}`,
      `Completion rule: ${objectiveCompletionHint(objective, progress)}`,
      conversationContext,
      activityContext,
      runtimeNotes ? `Runtime notes:\n${runtimeNotes}` : "",
    ].filter(Boolean);

    for (let step = 1; step <= MAX_STEPS; step += 1) {
      if (signal.aborted) throw new Error("Interrupted by user");
      sink.publish("thinking.delta", { message: `Agent step ${step}/${MAX_STEPS}` });
      transcript.push(`Progress before step ${step}: ${progressSummary(progress)}`);
      transcript.push(`Completion rule: ${objectiveCompletionHint(objective, progress)}`);
      const modelReply = await callProvider({
        model,
        userText: renderLoopPrompt(transcript),
        instructions: `${baseInstructions}\n${toolContract()}`,
        signal,
      });
      const action = parseToolCall(modelReply);
      if (action.type === "final") {
        const blockReason = finalBlockReason(content, action.content, objective, progress);
        if (blockReason) {
          blockedFinals += 1;
          transcript.push(`Final blocked: ${blockReason}`);
          transcript.push("Continue with tools and only return final when objective is completed.");
          continue;
        }
        sink.publish("message.delta", { content: action.content, role: "assistant" });
        sink.addAssistantMessage(action.content, "done");
        sink.publish("message.done", { content: action.content, role: "assistant" });
        sink.publish("thinking.done", { message: "Done" });
        sink.publish("session.done", { message: "Done" });
        sink.setSessionStatus("idle");
        return { objective, progress, success: true, blockedFinals } satisfies RuntimeResult;
      }
      try {
        progress.toolActions += 1;
        if (action.type === "run_command") progress.commandActions += 1;
        if (action.type === "write_file" || action.type === "apply_patch") progress.writeActions += 1;
        const result = await executeTool(action, { workspacePath, permission, signal, sink, requestApproval: input.requestApproval });
        transcript.push(`Tool result (${action.type}): ${result}`);
        transcript.push(`Progress after step ${step}: ${progressSummary(progress)}`);
      } catch (error) {
        const toolError = normalizeToolError(error);
        const tool = toolNameFor(action);
        sink.publish("tool.error", { tool, error: toolError, status: "error" });
        transcript.push(`Tool error (${action.type}): ${toolError.code} ${toolError.message}`);
      }
    }

    const fallback = objective.requiresExecution
      ? "Run berhenti sebelum objective selesai. Objective tetap aktif. Lanjutkan tool execution pada turn berikutnya."
      : "Aku belum dapat jawaban final yang valid. Coba kirim ulang pertanyaan lebih spesifik.";
    sink.publish("message.delta", { content: fallback, role: "assistant" });
    sink.addAssistantMessage(fallback, "done");
    sink.publish("message.done", { content: fallback, role: "assistant" });
    sink.publish("session.done", { message: "Done" });
    sink.setSessionStatus("idle");
    return { objective, progress, success: false, blockedFinals } satisfies RuntimeResult;
  } catch (error) {
    if (signal.aborted) {
      sink.setSessionStatus("idle");
      return { objective: deriveObjective(content), progress: { toolActions: 0, commandActions: 0, writeActions: 0 }, success: false, blockedFinals: 0 } satisfies RuntimeResult;
    }
    const message = `Provider request failed: ${error instanceof Error ? error.message : String(error)}`;
    sink.addAssistantMessage(message, "error");
    sink.publish("session.error", { message });
    sink.publish("message.done", { content: message, role: "assistant" });
    sink.setSessionStatus("idle");
    return { objective: deriveObjective(content), progress: { toolActions: 0, commandActions: 0, writeActions: 0 }, success: false, blockedFinals: 0 } satisfies RuntimeResult;
  }
}

function renderLoopPrompt(transcript: string[]) {
  return `${transcript.join("\n\n")}\n\nNext action: return JSON only.`;
}

function deriveObjective(content: string) {
  const normalized = content.trim().toLowerCase();
  const scaffold = /(buatkan|create|scaffold|landing page|website|web app|vite|nextjs|react app)/i.test(normalized);
  const implementation = /(implement|refactor|fix|bug|patch|edit|ubah|tambah|hapus|setup|install|jalankan|run|build|test)/i.test(normalized);
  if (scaffold) {
    return {
      kind: "scaffold" as const,
      requiresExecution: true,
      label: "Complete scaffold/setup flow end-to-end before final answer.",
    };
  }
  if (implementation) {
    return {
      kind: "implementation" as const,
      requiresExecution: true,
      label: "Complete implementation in workspace with real tool execution before final answer.",
    };
  }
  return { kind: "answer" as const, requiresExecution: false, label: "Answer user request accurately and concisely." };
}

function finalBlockReason(
  userContent: string,
  finalContent: string,
  objective: { kind: "answer" | "implementation" | "scaffold"; requiresExecution: boolean },
  progress: { toolActions: number; commandActions: number; writeActions: number },
) {
  const normalizedFinal = finalContent.trim().toLowerCase();
  if (!normalizedFinal) return "empty final response";
  if (/(kalau .*mau.*next|kalau mau.*lanjut|next aku|bisa lanjut|if you want|let me know)/i.test(normalizedFinal)) {
    return "deferred wording indicates incomplete execution";
  }
  if (objective.requiresExecution && progress.writeActions === 0 && progress.commandActions === 0) {
    return "execution-required objective has no command/write actions yet";
  }
  if (objective.kind === "scaffold" && progress.commandActions < 2 && progress.writeActions === 0) {
    return "scaffold objective requires more than one execution step (create/install/edit)";
  }
  if (objective.kind === "scaffold" && progress.writeActions === 0) {
    return "scaffold objective still has no file modifications";
  }
  if (objective.requiresExecution && /(npm|pnpm|yarn|run dev|run build|run test|create vite)/i.test(finalContent) && progress.commandActions === 0) {
    return "final gives command recipe without actually running commands";
  }
  if (!objective.requiresExecution && progress.toolActions >= MAX_STEPS - 1 && /lanjutkan instruksi/i.test(finalContent)) {
    return "loop exhausted without direct answer";
  }
  if (/(buatkan|create|implement|scaffold)/i.test(userContent) && progress.writeActions === 0 && /(siap|berikut|langkah|kode)/i.test(normalizedFinal)) {
    return "implementation asked but no file changes executed";
  }
  return "";
}

function progressSummary(progress: { toolActions: number; commandActions: number; writeActions: number }) {
  return `tools=${progress.toolActions} commands=${progress.commandActions} writes=${progress.writeActions}`;
}

function objectiveCompletionHint(
  objective: { kind: "answer" | "implementation" | "scaffold"; requiresExecution: boolean },
  progress: { toolActions: number; commandActions: number; writeActions: number },
) {
  if (objective.kind === "scaffold") {
    if (progress.commandActions === 0) return "Need scaffold/create command or equivalent setup action.";
    if (progress.commandActions < 2) return "Need follow-up execution after scaffold, usually install/build/run or validation.";
    if (progress.writeActions === 0) return "Need real file edits for produced app before final.";
    return "Can finalize only after concise completion summary grounded in executed work.";
  }
  if (objective.kind === "implementation") {
    if (progress.commandActions === 0 && progress.writeActions === 0) return "Need real command or file edit before final.";
    return "Keep using tools until requested implementation is done, then finalize.";
  }
  return "Answer latest request directly.";
}

function classifyPreflightMode(content: string): RuntimePreflightMode {
  const text = content.trim().toLowerCase();
  if (!text) return "none";
  const normalized = text.replace(/[!?.。，,]+$/g, "").trim();
  const smalltalk = new Set([
    "hai",
    "hi",
    "hello",
    "halo",
    "hey",
    "ok",
    "oke",
    "sip",
    "siap",
    "thanks",
    "thank you",
    "makasih",
    "terima kasih",
    "mantap",
    "gas",
    "lanjut",
    "next",
  ]);
  if (smalltalk.has(normalized)) return "none";
  if (normalized.length <= 24 && /^(hai|hi|hello|halo|hey|ok|oke|sip|siap|thanks|makasih|terima kasih)\b/.test(normalized)) return "none";

  const fullSignals = [
    "edit",
    "ubah",
    "patch",
    "fix",
    "build",
    "test",
    "run",
    "jalankan",
    "install",
    "hapus",
    "delete",
    "rename",
    "move",
    "refactor",
    "implement",
    "buat",
    "create",
    "tambah",
    "write",
    "command",
    "git",
  ];
  if (fullSignals.some((keyword) => normalized.includes(keyword))) return "full";

  const lightSignals = [
    "cek",
    "lihat",
    "scan",
    "workspace",
    "folder",
    "file",
    "struktur",
    "isi",
    "ada apa",
    "context",
    "ringkas",
    "rangkuman",
    "baca",
    "pahami",
  ];
  if (lightSignals.some((keyword) => normalized.includes(keyword))) return "light";
  return "none";
}

function buildConversationContext(
  history: Array<{ role: "user" | "assistant" | "system"; content: string; createdAt?: string }>,
  currentContent: string,
) {
  const clean = history
    .filter((message) => message.content.trim())
    .slice(-16)
    .map((message) => {
      const timestamp = message.createdAt ? ` @ ${message.createdAt}` : "";
      return `${message.role}${timestamp}: ${truncateForContext(message.content, 1_500)}`;
    });
  const hasCurrent = clean.some((line) => line.endsWith(currentContent));
  if (!hasCurrent) clean.push(`user: ${truncateForContext(currentContent, 1_500)}`);
  return [
    "Conversation context:",
    ...clean,
    "",
    "Answer the latest user message using this conversation context. If user asks what they asked earlier, refer to prior user messages.",
  ].join("\n");
}

function truncateForContext(value: string, max: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)} ...`;
}

function buildActivityContext(activity: AgentEvent[]) {
  const supported = new Set([
    "thinking.start",
    "thinking.delta",
    "thinking.done",
    "cmd.start",
    "cmd.done",
    "tool.start",
    "tool.done",
    "tool.error",
    "file.edit",
    "approval.requested",
    "approval.resolved",
    "session.done",
    "session.error",
  ]);
  const lines = activity
    .filter((event) => supported.has(event.type))
    .slice(-30)
    .map((event) => {
      const payload = event.payload || {};
      const summary = summarizeEventPayload(event.type, payload);
      return `${event.timestamp} ${event.type}${summary ? ` | ${summary}` : ""}`;
    });
  if (!lines.length) return "";
  return [
    "Recent activity context:",
    ...lines,
    "",
    "Use recent activity to avoid ambiguous answers and keep continuity.",
  ].join("\n");
}

function summarizeEventPayload(type: string, payload: Record<string, unknown>) {
  if (type.startsWith("cmd.")) {
    const command = String(payload.command || "");
    const exitCode = payload.exitCode === undefined ? "" : `exit=${String(payload.exitCode)}`;
    return [command, exitCode].filter(Boolean).join(" ");
  }
  if (type.startsWith("tool.")) {
    const tool = String(payload.tool || "");
    const status = String(payload.status || "");
    const output = String(payload.output || payload.message || "");
    return [tool, status, truncateForContext(output, 240)].filter(Boolean).join(" | ");
  }
  if (type === "file.edit") {
    const path = String(payload.path || "");
    const add = Number(payload.additions || 0);
    const del = Number(payload.deletions || 0);
    return `${path} +${add} -${del}`;
  }
  if (type.startsWith("approval.")) {
    const command = String(payload.command || "");
    const decision = String(payload.decision || payload.status || "");
    return [command, decision].filter(Boolean).join(" | ");
  }
  if (type.startsWith("thinking.") || type.startsWith("session.")) {
    return truncateForContext(String(payload.message || ""), 240);
  }
  return truncateForContext(JSON.stringify(payload), 240);
}

type ProviderCallInput = {
  model: string;
  userText: string;
  instructions: string;
  signal: AbortSignal;
};

type RuntimeConfig = {
  model: string;
  personality: string;
  reasoningEffort: string;
  instructions: string;
  memories: boolean;
  allowGlobalScan: boolean;
  provider: { baseUrl: string; wireApi: string };
};

async function callProvider(input: ProviderCallInput) {
  const runtime = readRuntimeConfig();
  const errors: string[] = [];
  for (let attempt = 0; attempt <= PROVIDER_MAX_RETRIES; attempt += 1) {
    const auth = resolveProviderAuth(runtime.provider);
    const apiKey = auth.token;
    if (!apiKey) throw new Error("Provider auth missing. Set API key or enable OAuth token.");
    const baseUrl = auth.baseUrl;
    if (!baseUrl) throw new Error("provider baseUrl missing in active FenCode config.json");
    const timeoutSignal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
    const combinedSignal = AbortSignal.any([input.signal, timeoutSignal]);
    if ((runtime.provider.wireApi || "").toLowerCase() === "responses") {
      const value = await callResponsesApi(baseUrl, apiKey, auth.accountId, input.model, input.userText, input.instructions, combinedSignal).catch((error) => {
        const message = error instanceof Error ? error.message : String(error || "");
        errors.push(message || "responses failed");
        if (shouldForceRefresh(error) && auth.mode === "oauth" && forceRefreshOauthToken()) return "";
        return "";
      });
      if (value.trim()) return value;
    }
    if (auth.mode === "oauth") {
      if (attempt >= PROVIDER_MAX_RETRIES) break;
      continue;
    }
    const fallback = await callChatCompletionsApi(baseUrl, apiKey, auth.accountId, input.model, input.userText, input.instructions, combinedSignal).catch((error) => {
      const message = error instanceof Error ? error.message : String(error || "");
      errors.push(message || "chat/completions failed");
      if (shouldForceRefresh(error) && auth.mode === "oauth" && forceRefreshOauthToken()) return "";
      return "";
    });
    if (fallback.trim()) return fallback;
    if (attempt >= PROVIDER_MAX_RETRIES) break;
  }
  if (errors.length) throw new Error([...new Set(errors)].join("; "));
  throw new Error("Empty response from provider");
}

function shouldForceRefresh(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /\b(401|403)\b/.test(message);
}

async function callResponsesApi(baseUrl: string, apiKey: string, accountId: string | undefined, model: string, userText: string, instructions: string, signal: AbortSignal) {
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
      input: [{ role: "user", content: [{ type: "input_text", text: userText }] }],
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`responses API ${response.status}${text ? `: ${safeError(text)}` : ""}`);
  }
  return readResponsesOutput(response);
}

async function callChatCompletionsApi(baseUrl: string, apiKey: string, accountId: string | undefined, model: string, userText: string, instructions: string, signal: AbortSignal) {
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
      messages: [{ role: "system", content: instructions }, { role: "user", content: userText }],
      stream: false,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`chat/completions API ${response.status}${text ? `: ${safeError(text)}` : ""}`);
  }
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return payload.choices?.[0]?.message?.content?.trim() || "";
}

function safeError(text: string) {
  return text.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-api-key]").slice(0, 320);
}

async function readResponsesOutput(response: Response) {
  const raw = await response.text();
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    const payload = JSON.parse(trimmed) as { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
    if (payload.output_text?.trim()) return payload.output_text;
    return (payload.output ?? []).flatMap((row) => row.content ?? []).filter((row) => row.type?.includes("text")).map((row) => row.text || "").join("\n").trim();
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
  const responsePayload = payload.response as { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> } | undefined;
  if (responsePayload?.output_text?.trim()) return responsePayload.output_text;
  return (responsePayload?.output ?? []).flatMap((row) => row.content ?? []).filter((row) => row.type?.includes("text")).map((row) => row.text || "").join("\n").trim();
}

function buildProviderCompatHeaders(accountId: string | undefined) {
  return {
    "x-client-request-id": randomUUID(),
    "x-codex-window-id": process.env.FCODE_WINDOW_ID || "1",
    ...(accountId ? { "ChatGPT-Account-ID": accountId } : {}),
  };
}

function buildRuntimeInstructions(workspacePath: string, permission: string, runtime: RuntimeConfig, memoryContext = "") {
  const base = [
    "You are FCode Agent, a local coding agent for this app.",
    `Runtime backend: fcode-server (Node/TypeScript).`,
    `Active model: ${runtime.model}.`,
    `Provider wire API: ${runtime.provider.wireApi}.`,
    `Current workspace root: ${workspacePath}`,
    `Current runtime permission mode: ${permission}`,
    `Permission summary: ${permissionSummary(permission)}`,
    `Global scan enabled: ${runtime.allowGlobalScan ? "yes" : "no"}.`,
    "Use tools when needed to inspect workspace and run command.",
  ];
  const personality = personalityInstructions(runtime.personality);
  if (personality) {
    base.push("Personality:");
    base.push(personality);
  }
  base.push(`Reasoning effort preference: ${runtime.reasoningEffort}`);
  if (memoryContext.trim()) {
    base.push("Memory context:");
    base.push(memoryContext.trim());
  }
  if (runtime.instructions?.trim()) {
    base.push("User custom instructions:");
    base.push(runtime.instructions.trim());
  }
  return base.join("\n");
}

function readRuntimeConfig() {
  const home = resolveFencodeHome();
  const file = path.join(home, "config.json");
  if (!fs.existsSync(file)) {
    return {
      model: "gpt-5.5",
      personality: "pragmatic",
      reasoningEffort: "medium",
      instructions: "",
      memories: true,
      provider: { baseUrl: "http://127.0.0.1:20128/v1", wireApi: "responses" },
      allowGlobalScan: false,
    };
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
    model?: string;
    personality?: string;
    reasoningEffort?: string;
    instructions?: string;
    features?: { memories?: boolean; allowGlobalScan?: boolean };
    provider?: { baseUrl?: string; wireApi?: string };
  };
  return {
    model: raw.model || "gpt-5.5",
    personality: raw.personality || "pragmatic",
    reasoningEffort: raw.reasoningEffort || "medium",
    instructions: raw.instructions || "",
    memories: raw.features?.memories ?? true,
    allowGlobalScan: raw.features?.allowGlobalScan ?? false,
    provider: { baseUrl: raw.provider?.baseUrl || "http://127.0.0.1:20128/v1", wireApi: raw.provider?.wireApi || "responses" },
  };
}

function personalityInstructions(personality: string) {
  const value = personality.trim().toLowerCase();
  if (value === "pragmatic") {
    return "Be concise, direct, task-focused, and practical. Prefer concrete next steps over broad explanation.";
  }
  if (value === "friendly") {
    return "Be warm, collaborative, and encouraging while staying useful and clear.";
  }
  if (value === "creative") {
    return "Be exploratory, idea-forward, and suggest alternatives when useful.";
  }
  return "";
}

function readMemoryContext(workspacePath: string) {
  const home = resolveFencodeHome();
  const memoryRoot = path.join(home, "memories");
  if (!fs.existsSync(memoryRoot)) return "";
  const files = collectMemoryFiles(memoryRoot);
  if (!files.length) return "";

  const workspaceKey = path.basename(workspacePath).toLowerCase();
  const prioritized = files.sort((left, right) => {
    const leftScore = left.toLowerCase().includes(workspaceKey) ? 1 : 0;
    const rightScore = right.toLowerCase().includes(workspaceKey) ? 1 : 0;
    return rightScore - leftScore || left.localeCompare(right);
  });

  const blocks: string[] = [];
  for (const file of prioritized.slice(0, 8)) {
    try {
      const content = fs.readFileSync(file, "utf8").trim();
      if (!content) continue;
      const rel = path.relative(memoryRoot, file).replaceAll("\\", "/");
      blocks.push(`## ${rel}\n${truncateForContext(content, 1_200)}`);
      if (blocks.join("\n\n").length > 3_000) break;
    } catch {
      continue;
    }
  }
  return blocks.join("\n\n");
}

function collectMemoryFiles(root: string) {
  const output: string[] = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    let rows: fs.Dirent[] = [];
    try {
      rows = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const row of rows) {
      if (row.name === ".git") continue;
      const absolute = path.join(current, row.name);
      if (row.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (!/\.(md|txt|jsonl)$/i.test(row.name)) continue;
      output.push(absolute);
    }
  }
  return output;
}
