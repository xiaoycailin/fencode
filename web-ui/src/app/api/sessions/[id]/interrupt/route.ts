import { NextResponse } from "next/server";
import { interruptAppServerTurn } from "@/lib/appServerBridge";
import { getSession, patchSession, updateMessage } from "@/lib/db";
import { publishEvent } from "@/lib/sse";
import { interruptExecutableSkill } from "@/lib/skillRunner";
import { cancelTodoProgress } from "@/lib/todoProgress";
import { proxyJson, shouldProxyToFcodeServer } from "@/lib/fcodeServerProxy";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (shouldProxyToFcodeServer()) {
    return proxyJson(request, `/sessions/${encodeURIComponent(id)}/interrupt`, { method: "POST", body: {} });
  }
  const activeRunId = getActiveRunId(id);
  const skill = interruptExecutableSkill(id);
  const appServer = await interruptAppServerTurn(id);
  const forced = forceCloseDanglingRun(id);
  const cancelledRunId = forced.runId || activeRunId;
  if (cancelledRunId) cancelTodoProgress(id, cancelledRunId);
  return NextResponse.json({ interrupted: skill.interrupted || appServer.interrupted || forced.interrupted, skill, appServer, forced });
}

function getActiveRunId(sessionId: string) {
  const detail = getSession(sessionId);
  if (!detail) return "";
  return [...detail.messages].reverse().find((message) => message.role === "assistant" && message.status === "streaming" && message.runId)?.runId ?? "";
}

function forceCloseDanglingRun(sessionId: string) {
  const detail = getSession(sessionId);
  if (!detail) return { interrupted: false };
  const assistant = [...detail.messages].reverse().find((message) =>
    message.role === "assistant" && message.status === "streaming" && message.runId,
  );
  const runId = assistant?.runId;
  if (!assistant || !runId) {
    patchSession(sessionId, { status: "idle" });
    return { interrupted: false };
  }
  updateMessage(sessionId, assistant.id, { content: "", status: "done" });
  publishEvent(sessionId, "thinking.done", { message: "Stopped by user" }, { runId });
  publishEvent(sessionId, "session.done", { message: "Stopped by user" }, { runId });
  patchSession(sessionId, { status: "idle" });
  return { interrupted: true, runId };
}
