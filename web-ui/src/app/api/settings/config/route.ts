import { NextResponse } from "next/server";
import { z } from "zod";
import { readFcodeConfig, writeFcodeConfig, writeRawFcodeConfig } from "@/lib/fcodeConfig";

const providerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.string().min(1),
  wireApi: z.string().min(1),
});

const patchSchema = z.union([
  z.object({ mode: z.literal("raw"), raw: z.string() }),
  z.object({
    mode: z.literal("structured"),
    modelProvider: z.string().min(1),
    model: z.string().min(1),
    personality: z.string().min(1),
    reasoningEffort: z.string().min(1),
    instructions: z.string(),
    memories: z.boolean(),
    allowGlobalScan: z.boolean(),
    provider: providerSchema,
    engineServerUrl: z.string().min(1),
    subagentModel: z.string(),
  }),
]);

export async function GET() {
  return NextResponse.json({ config: readFcodeConfig() });
}

export async function PATCH(request: Request) {
  const body = patchSchema.parse(await request.json());
  const hotReloaded = false;
  const hotReloadError = "Standalone JSON config mode";

  if (body.mode === "raw") {
    const config = writeRawFcodeConfig(body.raw);
    return NextResponse.json({
      config,
      hotReloaded,
      hotReloadError: "Raw JSON saved.",
    });
  }

  const config = writeFcodeConfig(body);
  return NextResponse.json({ config, hotReloaded, hotReloadError });
}
