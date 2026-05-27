import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { readFcodeConfig } from "@/lib/fcodeConfig";

function resolvePath(root: string, relative: string, allowGlobalScan: boolean, writeMode = false) {
  const rootResolved = path.resolve(root);
  const relativeLooksAbsolute = path.isAbsolute(relative);
  const absolute = relativeLooksAbsolute ? path.resolve(relative) : path.resolve(rootResolved, relative);
  const normalizedRoot = path.resolve(root);
  const insideRoot = absolute === normalizedRoot || absolute.startsWith(`${normalizedRoot}${path.sep}`);
  if (!insideRoot) {
    if (writeMode) throw new Error("Path escapes workspace root");
    if (!allowGlobalScan) throw new Error("Path escapes workspace root");
  }
  return absolute;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const root = url.searchParams.get("root") || process.env.DEFAULT_WORKSPACE_PATH || process.cwd();
  const relative = url.searchParams.get("path") ?? "README.md";
  const allowGlobalScan = readFcodeConfig().allowGlobalScan;
  try {
    const absolute = resolvePath(root, relative, allowGlobalScan, false);
    const content = await fs.readFile(absolute, "utf8");
    return NextResponse.json({ path: relative, content, language: path.extname(relative).slice(1) || "text" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read file";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const body = await request.json();
  const root = body.root || process.env.DEFAULT_WORKSPACE_PATH || process.cwd();
  try {
    const absolute = resolvePath(root, body.path, false, true);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, body.content ?? "", "utf8");
    return NextResponse.json({ ok: true, path: body.path });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to write file";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const root = url.searchParams.get("root") || process.env.DEFAULT_WORKSPACE_PATH || process.cwd();
  const relative = url.searchParams.get("path");
  if (!relative) return NextResponse.json({ error: "Missing path" }, { status: 400 });
  try {
    const absolute = resolvePath(root, relative, false, true);
    await fs.rm(absolute, { recursive: true, force: true });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete path";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
