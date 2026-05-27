import { NextResponse } from "next/server";
import { z } from "zod";
import { compactAppServerThreadFast, runAppServerTurn } from "@/lib/appServerBridge";
import { addMessage, compactSessionContext, estimateSessionContextUsage, getSession, patchSession } from "@/lib/db";
import { makeId, nowIso } from "@/lib/id";
import { runExecutableSkillIfAny } from "@/lib/skillRunner";
import { publishEvent } from "@/lib/sse";
import { failTodoProgress } from "@/lib/todoProgress";
import { proxyJson, shouldProxyToFcodeServer } from "@/lib/fcodeServerProxy";
import type { AgentInputItem } from "@/types/agentInput";

const sendMessageSchema = z.object({
  content: z.string().min(1),
  runId: z.string().optional(),
  input: z.array(z.any()).optional(),
});

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (shouldProxyToFcodeServer()) {
    return proxyJson(request, `/sessions/${encodeURIComponent(id)}/messages`, { method: "GET" });
  }
  const detail = getSession(id);
  if (!detail) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  return NextResponse.json({ data: detail.messages });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = sendMessageSchema.parse(await request.json());
  const normalizedInput = ensureSkillInput(body.content, body.input as AgentInputItem[] | undefined);
  if (shouldProxyToFcodeServer()) {
    return proxyJson(request, `/sessions/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      body: { ...body, input: normalizedInput },
    });
  }
  const detail = getSession(id);
  if (!detail) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  if (detail.session.status === "streaming") {
    return NextResponse.json({ error: "Session is already running" }, { status: 409 });
  }
  const runId = body.runId ?? makeId("run");
  const message = addMessage({
    id: makeId("msg"),
    sessionId: id,
    runId,
    role: "user",
    content: body.content,
    createdAt: nowIso(),
    status: "done",
  });
  const usage = estimateSessionContextUsage(id, detail.session.model);
  if (usage.usagePct >= 85 && detail.session.threadId) {
    publishEvent(id, "tool.start", { tool: "context.compact", input: { threadId: detail.session.threadId, mode: "auto" } }, { runId });
    addMessage({
      id: makeId("msg"),
      sessionId: id,
      runId,
      role: "system",
      content: "Context compacted",
      createdAt: nowIso(),
      status: "done",
    });
    compactSessionContext(id, "auto");
    void compactAppServerThreadFast(id, 12_000)
      .then(() => {
        publishEvent(id, "tool.done", { tool: "context.compact", output: "Thread context compacted", duration: 0 }, { runId });
      })
      .catch((error) => {
        publishEvent(id, "tool.done", {
          tool: "context.compact",
          output: `Local context compacted. App-server: ${error instanceof Error ? error.message : String(error)}`,
          duration: 0,
        }, { runId });
      });
  }
  const inputBase = normalizedInput ?? [{
    type: "text",
    text: body.content,
    textElements: [],
    text_elements: [],
  }];
  const input = inputBase;
  void runExecutableSkillIfAny(id, runId, body.content, input)
    .then((result) => {
      if (result.handled) return;
      return runAppServerTurn(id, body.content, runId, input).catch((error) => {
        patchSession(id, { status: "idle" });
        failTodoProgress(id, runId);
        const errorText = `App-server unavailable: ${error instanceof Error ? error.message : String(error)}`;
        const latest = getSession(id)?.messages.filter((entry) => entry.role === "assistant").at(-1);
        const alreadyHandled = latest?.runId === runId && (latest.status === "error" || latest.status === "done");
        if (!alreadyHandled) {
          addMessage({
            id: makeId("msg"),
            sessionId: id,
            runId,
            role: "assistant",
            content: errorText,
            createdAt: nowIso(),
            status: "error",
          });
          publishEvent(id, "message.done", { content: errorText, role: "assistant" }, { runId });
          publishEvent(id, "session.error", { message: errorText }, { runId });
        }
      });
    })
    .catch((error) => {
      patchSession(id, { status: "idle" });
      const errorText = `Failed to handle request: ${error instanceof Error ? error.message : String(error)}`;
      addMessage({
        id: makeId("msg"),
        sessionId: id,
        runId,
        role: "assistant",
        content: errorText,
        createdAt: nowIso(),
        status: "error",
      });
      publishEvent(id, "message.done", { content: errorText, role: "assistant" }, { runId });
      publishEvent(id, "session.error", { message: errorText }, { runId });
    });
  return NextResponse.json({ message }, { status: 202 });
}

function ensureSkillInput(content: string, input?: AgentInputItem[]) {
  const current = Array.isArray(input) ? [...input] : [];
  const hasImagegenSkill = current.some((item) => item.type === "skill" && isImagegenSkillId(item.id));
  if (!hasImagegenSkill && looksLikeImagegenMention(content)) {
    current.push({
      type: "skill",
      id: "system/imagegen",
      label: "Imagegen",
      value: "Generate or edit bitmap images",
      executable: true,
    });
  }
  if (current.length) return current;
  return input;
}

function looksLikeImagegenMention(content: string) {
  const text = content.toLowerCase();
  return text.includes("fcode-mention://skill/") && text.includes("imagegen")
    || /(^|\s)@imagegen\b/i.test(content)
    || /^\s*\[imagegen\]/i.test(content);
}

function isImagegenSkillId(id: string) {
  const normalized = id.toLowerCase().replace(/^\.f(?:code|encode)\//, "").replace(/[\\/]+/g, "/");
  return normalized.endsWith("system/imagegen") || normalized.endsWith("skills/imagegen") || normalized.endsWith("imagegen");
}
