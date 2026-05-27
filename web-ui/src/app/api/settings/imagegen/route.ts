import { NextResponse } from "next/server";
import { z } from "zod";
import { readImageGenSettings, writeImageGenSettings } from "@/lib/db";

const schema = z.object({
  selectedModel: z.string().optional(),
  addModel: z.string().optional(),
  removeModel: z.string().optional(),
});

export async function GET() {
  return NextResponse.json(readImageGenSettings());
}

export async function PATCH(request: Request) {
  const body = schema.parse(await request.json());
  const current = readImageGenSettings();
  let models = current.models;
  if (body.addModel?.trim()) models = [...new Set([...models, body.addModel.trim()])];
  if (body.removeModel?.trim()) models = models.filter((item) => item !== body.removeModel?.trim());
  return NextResponse.json(writeImageGenSettings({ models, selectedModel: body.selectedModel ?? current.selectedModel }));
}
