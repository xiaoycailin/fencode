import { NextResponse } from "next/server";
import { z } from "zod";
import { listSkills, upsertSkill } from "@/lib/db";

const schema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().min(1),
  instructions: z.string().min(1),
  trigger: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

export async function GET() {
  return NextResponse.json({ data: listSkills() });
}

export async function POST(request: Request) {
  const body = schema.parse(await request.json());
  return NextResponse.json({ skill: upsertSkill(body) }, { status: 201 });
}
