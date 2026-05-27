import { NextResponse } from "next/server";
import { deleteMcpServer } from "@/lib/db";

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deleteMcpServer(id);
  return NextResponse.json({ ok: true });
}
