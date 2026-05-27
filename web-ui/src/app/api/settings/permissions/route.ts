import { NextResponse } from "next/server";
import { z } from "zod";
import { readPermissionSettings, writePermissionSettings } from "@/lib/db";

const schema = z.object({
  level: z.enum(["ask-always", "ask-risky", "auto-approve"]).optional(),
  allowList: z.array(z.string()).optional(),
  blockList: z.array(z.string()).optional(),
});

export async function GET() {
  return NextResponse.json(readPermissionSettings());
}

export async function PATCH(request: Request) {
  const body = schema.parse(await request.json());
  return NextResponse.json(writePermissionSettings(body));
}
