import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteSession, getSession, patchSession } from "@/lib/db";
import { proxyJson, shouldProxyToFcodeServer } from "@/lib/fcodeServerProxy";

const updateSessionSchema = z.object({
  title: z.string().optional(),
  workspacePath: z.string().optional(),
  model: z.string().optional(),
  permission: z.enum(["read-only", "workspace-write", "full-access"]).optional(),
});

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (shouldProxyToFcodeServer()) {
    return proxyJson(request, `/sessions/${encodeURIComponent(id)}`, { method: "GET" });
  }
  const detail = getSession(id);
  if (!detail) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  return NextResponse.json(detail);
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = updateSessionSchema.parse(await request.json());
  if (shouldProxyToFcodeServer()) {
    return proxyJson(request, `/sessions/${encodeURIComponent(id)}`, { method: "PATCH", body });
  }
  const session = patchSession(id, body);
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  return NextResponse.json({ session });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (shouldProxyToFcodeServer()) {
    return proxyJson(request, `/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  deleteSession(id);
  return NextResponse.json({ ok: true });
}
