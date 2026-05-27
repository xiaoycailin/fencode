import { NextResponse } from "next/server";
import { listModels, listSkills, listWorkspaces } from "@/lib/db";

const settings: Record<string, unknown> = {
  theme: "system",
  defaultModel: "gpt-5.5",
  permissionLevel: "ask-risky",
  codeExecution: { enabled: false, reason: "Execution backend not connected" },
};

export async function GET() {
  return NextResponse.json({ ...settings, models: listModels(), skills: listSkills(), workspaces: listWorkspaces() });
}

export async function PATCH(request: Request) {
  const patch = await request.json().catch(() => ({}));
  Object.assign(settings, patch);
  return NextResponse.json(settings);
}
