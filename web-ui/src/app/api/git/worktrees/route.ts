import { NextResponse } from "next/server";
import simpleGit from "simple-git";

function parsePorcelain(text: string) {
  const blocks = text.split(/\n(?=worktree )/).map((chunk) => chunk.trim()).filter(Boolean);
  return blocks.map((block) => {
    const lines = block.split("\n");
    const row: Record<string, string> = {};
    for (const line of lines) {
      const [key, ...rest] = line.split(" ");
      row[key] = rest.join(" ");
    }
    return {
      path: row.worktree,
      head: row.HEAD,
      branch: row.branch?.replace("refs/heads/", "") ?? "(detached)",
      bare: "bare" in row,
      detached: "detached" in row,
      locked: row.locked,
      prunable: row.prunable,
    };
  });
}

export async function GET(request: Request) {
  const root = new URL(request.url).searchParams.get("root") || process.env.DEFAULT_WORKSPACE_PATH || process.cwd();
  try {
    const git = simpleGit(root);
    const raw = await git.raw(["worktree", "list", "--porcelain"]);
    return NextResponse.json({ data: parsePorcelain(raw) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list worktrees";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
