import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAppServer } from "../http.js";
import { loadStore } from "../store.js";

type Json = Record<string, unknown>;

const serverPort = Number(process.env.FCODE_SERVER_SMOKE_PORT || 32991);
const providerPort = Number(process.env.FCODE_PROVIDER_SMOKE_PORT || 32992);
const baseUrl = `http://127.0.0.1:${serverPort}`;
const workspacePath = path.join(os.tmpdir(), "fcode-server-golden-workspace");

async function main() {
  process.env.FENCODE_HOME = path.join(os.tmpdir(), "fcode-server-golden-home");
  process.env.FENCODE_SEED_DIR = path.join(os.tmpdir(), "fcode-server-golden-empty-seed");
  process.env.DEFAULT_WORKSPACE_PATH = workspacePath;
  process.env.OPENAI_API_KEY = "smoke";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${providerPort}/v1`;
  fs.rmSync(process.env.FENCODE_HOME, { recursive: true, force: true });
  fs.mkdirSync(process.env.FENCODE_SEED_DIR, { recursive: true });
  fs.mkdirSync(process.env.FENCODE_HOME, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(path.join(process.env.FENCODE_HOME, "auth.json"), JSON.stringify({
    auth_mode: "apikey",
    OPENAI_API_KEY: "smoke",
    OPENAI_BASE_URL: `http://127.0.0.1:${providerPort}/v1`,
  }, null, 2));

  const provider = startProvider();
  loadStore();
  const app = createAppServer();
  await listen(provider, providerPort);
  await listen(app, serverPort);

  try {
    await scenarioConversationContext();
    await scenarioCommandEvents();
    await scenarioPersistentDevCommand();
    await scenarioApprovalGate();
    await scenarioSmalltalkNoPreflight();
    await scenarioLightPreflight();
    await scenarioHttpErrors();
    console.log("golden smoke passed");
  } finally {
    await close(app);
    await close(provider);
  }
}

async function scenarioConversationContext() {
  const session = await createSession();
  await postMessage(session.id, "pertanyaan 1 kenapa monyet berbulu");
  await waitForIdle(session.id, 1);
  await postMessage(session.id, "pertanyaan 2 kenapa anjing kakinya 4");
  await waitForIdle(session.id, 2);
  await postMessage(session.id, "oke aku tadi tanya apa ya?");
  const detail = await waitForIdle(session.id, 3);
  const lastAssistant = [...detail.messages].reverse().find((message) => message.role === "assistant");
  assert(
    lastAssistant?.content.includes("monyet") && lastAssistant.content.includes("anjing"),
    `conversation context answer missing prior questions: ${lastAssistant?.content || "(empty)"}`,
  );
}

async function scenarioCommandEvents() {
  const session = await createSession();
  await postMessage(session.id, "jalankan command ringan");
  const detail = await waitForIdle(session.id, 1);
  assert(detail.events.some((event) => event.type === "cmd.start"), "cmd.start missing");
  assert(detail.events.some((event) => event.type === "cmd.done"), "cmd.done missing");
}

async function scenarioPersistentDevCommand() {
  const session = await createSession();
  await postMessage(session.id, "tes dev server hang");
  const detail = await waitForIdle(session.id, 1);
  const done = detail.events.find((event) => event.type === "cmd.done") as { payload?: { fullOutput?: string; exitCode?: number } } | undefined;
  assert(done?.payload?.exitCode === 0, "persistent dev command should finish as ready success");
  assert(
    String(done.payload.fullOutput || "").includes("Persistent dev/watch command detected"),
    "persistent dev command should explain readiness stop",
  );
}

async function scenarioHttpErrors() {
  const response = await requestJson("/sessions/missing/messages", { method: "GET" }, false);
  assert(response.status === 404, "missing session should be 404");
  const error = response.body.error as { code?: string } | undefined;
  assert(error?.code === "session_not_found", "missing session error code mismatch");
  const noPendingApproval = await requestJson("/sessions/missing/approval", { method: "POST", body: { decision: "approved" } }, false);
  assert(noPendingApproval.status === 409 || noPendingApproval.status === 404, "approval without pending should fail");
}

async function scenarioApprovalGate() {
  const session = await createSession("full-access");
  await postMessage(session.id, "tolong jalankan command berbahaya");
  const waiting = await waitForStatus(session.id, "waiting-approval");
  assert(waiting.events.some((event) => event.type === "approval.requested"), "approval.requested missing");
  const approval = await requestJson(`/sessions/${encodeURIComponent(session.id)}/approval`, {
    method: "POST",
    body: { decision: "approved" },
  });
  assert(approval.status === 200, "approval endpoint should accept approved decision");
  const done = await waitForIdle(session.id, 1);
  assert(done.events.some((event) => event.type === "approval.resolved"), "approval.resolved missing");
  assert(done.events.some((event) => event.type === "cmd.done"), "cmd.done missing after approval");
}

async function scenarioSmalltalkNoPreflight() {
  const session = await createSession();
  await postMessage(session.id, "hai");
  const detail = await waitForIdle(session.id, 1);
  assert(!detail.events.some((event) => event.type === "cmd.start"), "smalltalk should not run git preflight");
  const hasWorkspaceScan = detail.events.some((event) =>
    event.type.startsWith("tool.") &&
    String((event as { payload?: { tool?: string } }).payload?.tool || "") === "workspace.scan",
  );
  assert(!hasWorkspaceScan, "smalltalk should not run workspace.scan preflight");
}

async function scenarioLightPreflight() {
  const session = await createSession();
  await postMessage(session.id, "cek workspace ini");
  const detail = await waitForIdle(session.id, 1);
  const hasWorkspaceScan = detail.events.some((event) =>
    event.type.startsWith("tool.") &&
    String((event as { payload?: { tool?: string } }).payload?.tool || "") === "workspace.scan",
  );
  assert(hasWorkspaceScan, "light preflight should run workspace.scan");
  assert(!detail.events.some((event) => event.type === "cmd.start"), "light preflight should not run git status");
}

function startProvider() {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST") return sendJson(response, 404, { error: "not found" });
    const body = await readJsonBody(request);
    const userText = extractUserText(body);
    const next = selectReply(userText);
    return sendJson(response, 200, { output_text: JSON.stringify(next) });
  });
}

async function createSession(permission: "workspace-write" | "full-access" = "workspace-write") {
  const response = await requestJson("/sessions", {
    method: "POST",
    body: { title: "Golden", workspacePath, model: "smoke", permission },
  });
  return response.body.session as { id: string };
}

async function postMessage(sessionId: string, content: string) {
  const response = await requestJson(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    body: { content },
  });
  assert(response.status === 202, `message post failed ${response.status}`);
}

async function waitForIdle(sessionId: string, minAssistantMessages: number) {
  for (let i = 0; i < 80; i += 1) {
    const response = await requestJson(`/sessions/${encodeURIComponent(sessionId)}`, { method: "GET" });
    const detail = response.body as {
      session: { status: string };
      messages: Array<{ role: string; content: string }>;
      events: Array<{ type: string }>;
    };
    const assistantCount = detail.messages.filter((message) => message.role === "assistant").length;
    if (detail.session.status === "idle" && assistantCount >= minAssistantMessages) return detail;
    await sleep(100);
  }
  throw new Error("session did not become idle");
}

async function waitForStatus(sessionId: string, expectedStatus: string) {
  for (let i = 0; i < 80; i += 1) {
    const response = await requestJson(`/sessions/${encodeURIComponent(sessionId)}`, { method: "GET" });
    const detail = response.body as {
      session: { status: string };
      messages: Array<{ role: string; content: string }>;
      events: Array<{ type: string }>;
    };
    if (detail.session.status === expectedStatus) return detail;
    await sleep(100);
  }
  throw new Error(`session did not become ${expectedStatus}`);
}

async function requestJson(pathname: string, init: { method: string; body?: Json }, requireOk = true) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: init.method,
    headers: { "Content-Type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const body = await response.json() as Json;
  if (requireOk && !response.ok) throw new Error(`${init.method} ${pathname} failed ${response.status}: ${JSON.stringify(body)}`);
  return { status: response.status, body };
}

function listen(server: http.Server, port: number) {
  return new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
}

function close(server: http.Server) {
  return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function sendJson(response: http.ServerResponse, status: number, body: Json) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Json;
}

function extractUserText(body: Json) {
  const input = Array.isArray(body.input) ? body.input : [];
  const first = input[0] as { content?: Array<{ text?: string }> } | undefined;
  return String(first?.content?.[0]?.text ?? "");
}

function selectReply(userText: string) {
  if (userText.includes("oke aku tadi tanya apa ya?")) {
    return { type: "final", content: "Kamu tadi tanya kenapa monyet berbulu dan kenapa anjing kakinya 4." };
  }
  if (userText.includes("jalankan command ringan") && !userText.includes("Tool result (run_command)")) {
    return { type: "run_command", command: "Get-ChildItem -Name", reason: "exercise command event" };
  }
  if (userText.includes("tes dev server hang") && !userText.includes("Tool result (run_command)")) {
    return {
      type: "run_command",
      command: "Write-Output 'npm run dev'; Write-Output '  VITE v8.0.14 ready in 1 ms'; Write-Output '  ➜  Local:   http://localhost:5173/'; Start-Sleep -Seconds 20",
      reason: "exercise persistent dev readiness",
    };
  }
  if (userText.includes("jalankan command berbahaya") && !userText.includes("Tool result (run_command)")) {
    return { type: "run_command", command: "Remove-Item -Recurse temp", reason: "exercise approval gate" };
  }
  return { type: "final", content: "Done." };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
