import { NextResponse } from "next/server";
import { z } from "zod";
import simpleGit from "simple-git";

const schema = z.object({
  root: z.string().optional(),
  paths: z.array(z.string()).default([]),
});

export async function POST(request: Request) {
  const body = schema.parse(await request.json());
  const root = body.root || process.env.DEFAULT_WORKSPACE_PATH || process.cwd();
  const git = simpleGit(root);
  await git.add(body.paths.length ? body.paths : ["."]);
  return NextResponse.json({ ok: true });
}
