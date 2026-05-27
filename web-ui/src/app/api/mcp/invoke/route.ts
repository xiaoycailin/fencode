import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { z } from "zod";
import { listMcpServers } from "@/lib/db";

const execFileAsync = promisify(execFile);

const schema = z.object({
  serverId: z.string(),
  args: z.array(z.string()).optional(),
});

export async function POST(request: Request) {
  const body = schema.parse(await request.json());
  const server = listMcpServers().find((row) => row.id === body.serverId);
  if (!server) return NextResponse.json({ error: "Server not found" }, { status: 404 });
  if (server.transport === "sse") return NextResponse.json({ error: "SSE MCP invoke not wired yet" }, { status: 400 });
  if (!server.command) return NextResponse.json({ error: "Missing command" }, { status: 400 });
  try {
    const result = await execFileAsync(server.command, body.args ?? [], { timeout: 15_000 });
    return NextResponse.json({ stdout: result.stdout, stderr: result.stderr });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invoke failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
