import { addMessage, patchSession, updateMessage } from "./db";
import { makeId, nowIso } from "./id";
import { publishEvent } from "./sse";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const demoChunks = [
  "Aku siap bantu sebagai FCode agent coding. ",
  "FCode Web UI V2 sudah punya chat realtime, activity feed inline, dan state session yang stabil. ",
  "Langkah berikutnya tinggal sambungkan penuh ke app-server v2 JSON-RPC atau agent subprocess langsung. ",
  "UI dibuat FCode Desktop-like: sidebar compact, canvas luas, work timeline gelap, dan composer floating. ",
];

export async function runAgentSession(sessionId: string, userText: string, runId = makeId("run")) {
  const meta = { runId };
  patchSession(sessionId, { status: "streaming" });
  publishEvent(sessionId, "thinking.start", { message: "Agent started reasoning" }, meta);
  await sleep(220);
  publishEvent(sessionId, "thinking.delta", { message: "Reading workspace context and session state." }, meta);
  await sleep(280);
  publishEvent(sessionId, "tool.start", { tool: "workspace.scan", input: { depth: 2 } }, meta);
  await sleep(240);
  publishEvent(sessionId, "tool.done", { tool: "workspace.scan", output: "Workspace context ready", duration: 240 }, meta);
  publishEvent(sessionId, "cmd.start", {
    command: "npm run build",
    shell: "powershell",
    cwd: process.env.DEFAULT_WORKSPACE_PATH ?? "D:\\1aiagent-coding",
    pid: Math.floor(Math.random() * 10000),
  }, meta);
  await sleep(240);
  publishEvent(sessionId, "cmd.output", { pid: 1, stream: "stdout", chunk: "Typecheck passed\\n" }, meta);
  await sleep(180);
  publishEvent(sessionId, "cmd.done", { pid: 1, exitCode: 0, duration: 420, fullOutput: "Typecheck passed\\nBuild passed", expandable: false }, meta);

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

  let content = "";
  for (const chunk of buildResponse(userText)) {
    content += chunk;
    publishEvent(sessionId, "message.delta", { content: chunk, role: "assistant" }, { runId, messageId: assistantId });
    updateMessage(sessionId, assistantId, { content, status: "streaming" });
    await sleep(70);
  }

  publishEvent(sessionId, "file.edit", {
    path: "src/app/(app)/chat/[sessionId]/page.tsx",
    diff: "@@ -1,3 +1,3 @@\\n- old chat shell\\n+ FCode chat shell",
    hunks: 1,
    additions: 1,
    deletions: 1,
    expandable: true,
  }, meta);
  updateMessage(sessionId, assistantId, { content, status: "done" });
  publishEvent(sessionId, "message.done", { content, role: "assistant" }, { runId, messageId: assistantId });
  publishEvent(sessionId, "thinking.done", { message: "Reasoning complete" }, meta);
  publishEvent(sessionId, "session.done", { message: "Agent idle" }, meta);
  patchSession(sessionId, { status: "idle" });
}

function buildResponse(userText: string) {
  if (userText.toLowerCase().includes("approval")) {
    return [
      "Aku butuh approval untuk aksi berisiko tinggi. ",
      "Permission request akan tampil sebagai blocking card di activity feed, bukan browser alert. ",
      "Setelah user pilih Allow atau Deny, event `permission.response` dikirim balik ke agent. ",
    ];
  }
  return demoChunks;
}
