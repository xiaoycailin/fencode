import { NextResponse } from "next/server";
import { z } from "zod";
import { listMcpServers, upsertMcpServer } from "@/lib/db";

const schema = z.object({
  name: z.string().min(1),
  transport: z.enum(["stdio", "sse"]),
  command: z.string().optional(),
  url: z.string().optional(),
});

export async function GET() {
  return NextResponse.json({ data: listMcpServers() });
}

export async function POST(request: Request) {
  const body = schema.parse(await request.json());
  return NextResponse.json({ server: upsertMcpServer(body) }, { status: 201 });
}
