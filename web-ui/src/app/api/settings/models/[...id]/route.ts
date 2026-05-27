import { NextResponse } from "next/server";
import { deleteModel } from "@/lib/db";

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string[] }> }) {
  const { id } = await params;
  const joinedId = id.join("/");
  deleteModel(joinedId);
  return NextResponse.json({ ok: true });
}
