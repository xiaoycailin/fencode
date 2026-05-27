import fs from "node:fs/promises";
import path from "node:path";
import type { TreeNode } from "./types.js";

const ignore = new Set([".git", "node_modules", ".next", ".next-v2", "dist", "build"]);

export async function readTree(root: string, depth: number, includeIgnored: boolean) {
  return readTreeInner(root, root, Math.min(Math.max(depth, 1), 6), includeIgnored);
}

export async function readTextFile(root: string, relative: string) {
  const absolute = resolveInsideRoot(root, relative);
  return fs.readFile(absolute, "utf8");
}

export async function writeTextFile(root: string, relative: string, content: string) {
  const absolute = resolveInsideRoot(root, relative);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, "utf8");
}

export async function applyTextPatch(
  root: string,
  relative: string,
  search: string,
  replace: string,
  replaceAll = false,
) {
  const absolute = resolveInsideRoot(root, relative);
  const current = await fs.readFile(absolute, "utf8");
  if (!search) throw new Error("search is required");
  if (!current.includes(search)) throw new Error("search text not found");

  const next = replaceAll ? current.split(search).join(replace) : current.replace(search, replace);
  if (next === current) throw new Error("patch produced no changes");

  await fs.writeFile(absolute, next, "utf8");
  return {
    before: current,
    after: next,
    replacements: replaceAll ? current.split(search).length - 1 : 1,
  };
}

export async function applyStructuredPatch(root: string, relative: string, patch: string) {
  const absolute = resolveInsideRoot(root, relative);
  const current = await fs.readFile(absolute, "utf8");
  const blocks = parseReplaceBlocks(patch);
  if (!blocks.length) throw new Error("invalid patch format");

  let next = current;
  let replacements = 0;
  for (const block of blocks) {
    if (!block.search) throw new Error("patch block missing OLD section");
    if (!next.includes(block.search)) throw new Error("patch OLD text not found");
    next = next.replace(block.search, block.replace);
    replacements += 1;
  }
  if (next === current) throw new Error("patch produced no changes");

  await fs.writeFile(absolute, next, "utf8");
  return { before: current, after: next, replacements };
}

export async function deletePath(root: string, relative: string) {
  const absolute = resolveInsideRoot(root, relative);
  await fs.rm(absolute, { recursive: true, force: true });
}

export async function listWorkspaceFiles(root: string, depth: number, includeIgnored: boolean) {
  const base = path.resolve(root);
  const output: string[] = [];
  await listWorkspaceFilesInner(base, base, Math.min(Math.max(depth, 1), 8), includeIgnored, output);
  return output.sort((a, b) => a.localeCompare(b));
}

export async function listWorkspaceEntries(root: string, depth: number, includeIgnored: boolean) {
  const base = path.resolve(root);
  const output: string[] = [];
  await listWorkspaceEntriesInner(base, base, Math.min(Math.max(depth, 1), 8), includeIgnored, output);
  return output.sort((a, b) => a.localeCompare(b));
}

export async function searchWorkspaceFiles(root: string, query: string, maxResults = 20) {
  const files = await listWorkspaceFiles(root, 6, false);
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const output: Array<{ path: string; line: number; preview: string }> = [];
  for (const file of files) {
    if (output.length >= maxResults) break;
    const absolute = resolveInsideRoot(root, file);
    let content = "";
    try {
      content = await fs.readFile(absolute, "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].toLowerCase().includes(needle)) continue;
      output.push({ path: file, line: index + 1, preview: lines[index].trim().slice(0, 240) });
      if (output.length >= maxResults) break;
    }
  }
  return output;
}

function resolveInsideRoot(root: string, relative: string) {
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
    throw new Error("Path escapes workspace root");
  }
  return target;
}

async function readTreeInner(root: string, current: string, depth: number, includeIgnored: boolean): Promise<TreeNode[]> {
  if (depth <= 0) return [];
  const rows = await fs.readdir(current, { withFileTypes: true });
  const output: TreeNode[] = [];

  for (const row of rows) {
    if (!includeIgnored && ignore.has(row.name)) continue;
    const absolute = path.join(current, row.name);
    const relative = path.relative(root, absolute).replaceAll("\\", "/");
    if (row.isDirectory()) {
      output.push({
        id: relative || row.name,
        name: row.name,
        path: relative || ".",
        type: "directory",
        children: await readTreeInner(root, absolute, depth - 1, includeIgnored),
      });
    } else {
      output.push({ id: relative, name: row.name, path: relative, type: "file" });
    }
  }

  return output.sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name));
}

async function listWorkspaceFilesInner(
  root: string,
  current: string,
  depth: number,
  includeIgnored: boolean,
  output: string[],
) {
  if (depth <= 0) return;
  const rows = await fs.readdir(current, { withFileTypes: true });
  for (const row of rows) {
    if (!includeIgnored && ignore.has(row.name)) continue;
    const absolute = path.join(current, row.name);
    const relative = path.relative(root, absolute).replaceAll("\\", "/");
    if (row.isDirectory()) {
      await listWorkspaceFilesInner(root, absolute, depth - 1, includeIgnored, output);
    } else {
      output.push(relative);
    }
  }
}

async function listWorkspaceEntriesInner(
  root: string,
  current: string,
  depth: number,
  includeIgnored: boolean,
  output: string[],
) {
  if (depth <= 0) return;
  const rows = await fs.readdir(current, { withFileTypes: true });
  for (const row of rows) {
    if (!includeIgnored && ignore.has(row.name)) continue;
    const absolute = path.join(current, row.name);
    const relative = path.relative(root, absolute).replaceAll("\\", "/");
    if (row.isDirectory()) {
      output.push(`[dir] ${relative || row.name}`);
      await listWorkspaceEntriesInner(root, absolute, depth - 1, includeIgnored, output);
    } else {
      output.push(`[file] ${relative}`);
    }
  }
}

function parseReplaceBlocks(patch: string) {
  const lines = patch.split(/\r?\n/);
  const blocks: Array<{ search: string; replace: string }> = [];
  let i = 0;

  while (i < lines.length) {
    const row = lines[i].trim();
    if (row !== "*** Replace") {
      i += 1;
      continue;
    }
    i += 1;
    if (lines[i]?.trim() !== "*** OLD") throw new Error("patch block must contain *** OLD");
    i += 1;
    const oldLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "*** NEW") {
      oldLines.push(lines[i]);
      i += 1;
    }
    if (lines[i]?.trim() !== "*** NEW") throw new Error("patch block must contain *** NEW");
    i += 1;
    const newLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "*** End Replace") {
      newLines.push(lines[i]);
      i += 1;
    }
    if (lines[i]?.trim() !== "*** End Replace") throw new Error("patch block must end with *** End Replace");
    i += 1;
    blocks.push({ search: oldLines.join("\n"), replace: newLines.join("\n") });
  }

  return blocks;
}
