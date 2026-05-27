import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function gitStatus(root: string) {
  try {
    const [branch, porcelain, lastCommit] = await Promise.all([
      git(root, ["branch", "--show-current"]).catch(() => ""),
      git(root, ["status", "--porcelain=v1"]),
      git(root, ["log", "-1", "--format=%h"]).catch(() => ""),
    ]);
    const files = parseStatus(porcelain);
    return {
      isRepo: true,
      root,
      branch: branch.trim() || "unknown",
      changedFiles: files.length,
      stagedFiles: files.filter((file) => file.index.trim()).length,
      unstagedFiles: files.filter((file) => file.working_dir.trim()).length,
      untrackedFiles: files.filter((file) => file.index === "?" && file.working_dir === "?").length,
      additions: 0,
      deletions: 0,
      lastCommit: lastCommit.trim() || undefined,
      files,
    };
  } catch (error) {
    return { isRepo: false, root, error: error instanceof Error ? error.message : "No Git repository detected" };
  }
}

export async function gitDiff(root: string, file?: string | null) {
  const args = file ? ["diff", "--", file] : ["diff"];
  const diff = await git(root, args).catch(() => "");
  return { root, path: file ?? null, diff };
}

export async function gitStage(root: string, paths: string[]) {
  await git(root, ["add", ...(paths.length ? paths : ["."])]);
  return { ok: true };
}

export async function gitCommit(root: string, message: string) {
  const output = await git(root, ["commit", "-m", message]);
  const commit = output.match(/\[[^\s]+ ([a-f0-9]+)]/)?.[1];
  return { ok: true, commit, summary: output };
}

async function git(root: string, args: string[]) {
  const { stdout } = await exec("git", args, { cwd: root, windowsHide: true });
  return stdout;
}

function parseStatus(text: string) {
  return text.split(/\r?\n/).filter(Boolean).map((line) => {
    const index = line.slice(0, 1);
    const workingDir = line.slice(1, 2);
    const filePath = line.slice(3).replace(/^"|"$/g, "");
    return { path: filePath, working_dir: workingDir, index };
  });
}

