import { NextResponse } from "next/server";
import { z } from "zod";
import { listModels, upsertModel } from "@/lib/db";

const schema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  contextWindow: z.number().optional(),
  inputModalities: z.array(z.string()).optional(),
});

export async function GET() {
  return NextResponse.json({ data: listModels().map((model) => ({ ...model, apiKey: model.apiKey ? `***${model.apiKey.slice(-4)}` : "" })) });
}

export async function POST(request: Request) {
  const body = schema.parse(await request.json());
  return NextResponse.json({ model: upsertModel(body) }, { status: 201 });
}
