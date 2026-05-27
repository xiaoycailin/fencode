import { NextResponse } from "next/server";
import { z } from "zod";
import { createSession, listSessions } from "@/lib/db";
import { proxyJson, shouldProxyToFcodeServer } from "@/lib/fcodeServerProxy";

const createSessionSchema = z.object({
  title: z.string().optional(),
  workspacePath: z.string().optional(),
  model: z.string().optional(),
  permission: z.enum(["read-only", "workspace-write", "full-access"]).optional(),
});

export async function GET(request: Request) {
  if (shouldProxyToFcodeServer()) {
    return proxyJson(request, "/sessions", { method: "GET" });
  }
  return NextResponse.json({ data: listSessions() });
}

export async function POST(request: Request) {
  const body = createSessionSchema.parse(await request.json().catch(() => ({})));
  if (shouldProxyToFcodeServer()) {
    return proxyJson(request, "/sessions", { method: "POST", body });
  }
  const session = createSession(body);
  return NextResponse.json({ session }, { status: 201 });
}
