import { NextResponse } from "next/server";
import { z } from "zod";
import { listPersonas, upsertPersona } from "@/lib/db";

const schema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  prompt: z.string().min(1),
  temperature: z.number().optional(),
});

export async function GET() {
  return NextResponse.json({ data: listPersonas() });
}

export async function POST(request: Request) {
  const body = schema.parse(await request.json());
  return NextResponse.json({ persona: upsertPersona(body) }, { status: 201 });
}
