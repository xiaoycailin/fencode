import { NextResponse } from "next/server";
import simpleGit from "simple-git";

export async function GET(request: Request) {
  const root = new URL(request.url).searchParams.get("root") || process.env.DEFAULT_WORKSPACE_PATH || process.cwd();
  try {
    const git = simpleGit(root);
    const [status, branch, log] = await Promise.all([
      git.status(),
      git.branchLocal().catch(() => null),
      git.log({ maxCount: 1 }).catch(() => null),
    ]);
    const diff = await readDiffTotals(git);
    return NextResponse.json({
      isRepo: true,
      root,
      branch: status.current || branch?.current || "unknown",
      changedFiles: status.files.length,
      stagedFiles: status.staged.length,
      unstagedFiles: status.modified.length + status.deleted.length + status.renamed.length,
      untrackedFiles: status.not_added.length,
      additions: diff.additions,
      deletions: diff.deletions,
      lastCommit: log?.latest?.hash?.slice(0, 7),
      files: status.files,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "No Git repository detected";
    return NextResponse.json({ isRepo: false, root, error: message });
  }
}

async function readDiffTotals(git: ReturnType<typeof simpleGit>) {
  const [stagedRaw, unstagedRaw] = await Promise.all([
    git.diff(["--numstat", "--cached"]).catch(() => ""),
    git.diff(["--numstat"]).catch(() => ""),
  ]);
  let additions = 0;
  let deletions = 0;
  for (const block of [stagedRaw, unstagedRaw]) {
    for (const line of String(block).split(/\r?\n/)) {
      const [added, removed] = line.trim().split(/\s+/, 3);
      if (!added || !removed) continue;
      const plus = Number(added);
      const minus = Number(removed);
      if (Number.isFinite(plus)) additions += plus;
      if (Number.isFinite(minus)) deletions += minus;
    }
  }
  return { additions, deletions };
}
