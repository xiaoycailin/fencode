import { NextResponse } from "next/server";
import { z } from "zod";
import { listWorkspaces, upsertWorkspace } from "@/lib/db";

const schema = z.object({
  id: z.string().optional(),
  label: z.string().optional(),
  path: z.string().min(1),
});

export async function GET() {
  return NextResponse.json({ data: listWorkspaces() });
}

export async function POST(request: Request) {
  const body = schema.parse(await request.json());
  return NextResponse.json({ workspace: upsertWorkspace(body) }, { status: 201 });
}
