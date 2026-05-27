import { NextResponse } from "next/server";
import { deleteWorkspace } from "@/lib/db";

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deleteWorkspace(id);
  return NextResponse.json({ ok: true });
}
