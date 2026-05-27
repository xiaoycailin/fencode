import { NextResponse } from "next/server";
import { deletePersona } from "@/lib/db";

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deletePersona(id);
  return NextResponse.json({ ok: true });
}
