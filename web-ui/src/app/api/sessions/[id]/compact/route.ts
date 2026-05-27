import { NextResponse } from "next/server";
import { z } from "zod";
import { compactAppServerThreadFast } from "@/lib/appServerBridge";
import { addMessage, compactSessionContext, getSession, patchSession } from "@/lib/db";
import { makeId, nowIso } from "@/lib/id";
import { publishEvent } from "@/lib/sse";
import { proxyJson, shouldProxyToFcodeServer } from "@/lib/fcodeServerProxy";

const compactSchema = z.object({
  mode: z.enum(["manual", "auto"]).optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = compactSchema.parse(await request.json().catch(() => ({})));
  if (shouldProxyToFcodeServer()) {
    return proxyJson(request, `/sessions/${encodeURIComponent(id)}/compact`, { method: "POST", body });
  }
  const detail = getSession(id);
  if (!detail) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  if (!detail.session.threadId) {
    return NextResponse.json({ error: "No app-server thread yet. Send one message first, then compact." }, { status: 409 });
  }
  const runId = makeId(body.mode === "auto" ? "compact_auto" : "compact");
  publishEvent(id, "tool.start", { tool: "context.compact", input: { threadId: detail.session.threadId } }, { runId });
  const marker = addMessage({
    id: makeId("msg"),
    sessionId: id,
    runId,
    role: "system",
    content: "Context compacted",
    createdAt: nowIso(),
    status: "done",
  });
  const session = compactSessionContext(id, body.mode ?? "manual") ?? patchSession(id, { compactedAt: nowIso() });
  let appServer: Awaited<ReturnType<typeof compactAppServerThreadFast>> | { ok: false; reason: string };
  try {
    appServer = await compactAppServerThreadFast(id);
  } catch (error) {
    appServer = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  publishEvent(id, "tool.done", {
    tool: "context.compact",
    output: appServer.ok ? "Thread context compacted" : `Local context compacted. App-server: ${appServer.reason}`,
    duration: 0,
  }, { runId });
  return NextResponse.json({ session, appServer, marker });
}
