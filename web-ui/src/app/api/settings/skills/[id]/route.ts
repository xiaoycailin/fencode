import { NextResponse } from "next/server";
import { deleteSkill } from "@/lib/db";

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deleteSkill(id);
  return NextResponse.json({ ok: true });
}
