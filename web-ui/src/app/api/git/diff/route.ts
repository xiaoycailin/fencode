import { NextResponse } from "next/server";
import simpleGit from "simple-git";
import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_UNTRACKED_PREVIEW_BYTES = 256_000;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const root = url.searchParams.get("root") || process.env.DEFAULT_WORKSPACE_PATH || process.cwd();
  const file = url.searchParams.get("path");
  try {
    const git = simpleGit(root);
    let diff = file
      ? await git.diff(["--", file]).catch(() => "")
      : await git.diff().catch(() => "");

    if (file) {
      if (!diff.trim()) {
        const staged = await git.diff(["--cached", "--", file]).catch(() => "");
        if (staged.trim()) diff = staged;
      }

      if (!diff.trim()) {
        const status = await git.status().catch(() => null);
        const isUntracked = Boolean(status?.not_added?.includes(file));
        if (isUntracked) {
          const absolute = path.join(root, file);
          const stat = await fs.stat(absolute).catch(() => null);
          if (stat && stat.size > MAX_UNTRACKED_PREVIEW_BYTES) {
            diff = `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,1 @@\n+<preview skipped: file too large (${stat.size} bytes)>\n`;
          } else {
            const raw = await fs.readFile(absolute).catch(() => null);
            if (raw && !looksBinary(raw)) {
              const content = raw.toString("utf8");
              const lines = content.split("\n").map((line) => `+${line}`).join("\n");
              diff = `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${content.split("\n").length} @@\n${lines}\n`;
            } else if (raw) {
              diff = `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,1 @@\n+<binary file preview unavailable>\n`;
            }
          }
        }
      }
    }
    return NextResponse.json({ root, path: file, diff });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read diff";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function looksBinary(buffer: Buffer) {
  const scanLength = Math.min(buffer.length, 8_192);
  for (let index = 0; index < scanLength; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}
