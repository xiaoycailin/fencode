import { NextResponse } from "next/server";
import { z } from "zod";
import simpleGit from "simple-git";

const schema = z.object({
  root: z.string().optional(),
  path: z.string().min(1),
  force: z.boolean().optional(),
});

export async function POST(request: Request) {
  const body = schema.parse(await request.json());
  const root = body.root || process.env.DEFAULT_WORKSPACE_PATH || process.cwd();
  const git = simpleGit(root);
  await git.raw(body.force ? ["worktree", "remove", "--force", body.path] : ["worktree", "remove", body.path]);
  return NextResponse.json({ ok: true });
}
