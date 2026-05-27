import fs from "node:fs/promises";
import path from "node:path";
import { readFcodeConfig } from "@/lib/fcodeConfig";

function resolvePath(root: string, relative: string, allowGlobalScan: boolean) {
  const rootResolved = path.resolve(root);
  const relativeLooksAbsolute = path.isAbsolute(relative);
  const absolute = relativeLooksAbsolute ? path.resolve(relative) : path.resolve(rootResolved, relative);
  const normalizedRoot = path.resolve(root);
  const insideRoot = absolute === normalizedRoot || absolute.startsWith(`${normalizedRoot}${path.sep}`);
  if (!insideRoot && !allowGlobalScan) throw new Error("Path escapes workspace root");
  return absolute;
}

function mimeTypeFor(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const root = url.searchParams.get("root") || process.env.DEFAULT_WORKSPACE_PATH || process.cwd();
  const relative = url.searchParams.get("path");
  if (!relative) return new Response("Missing path", { status: 400 });
  const allowGlobalScan = readFcodeConfig().allowGlobalScan;
  try {
    const absolute = resolvePath(root, relative, allowGlobalScan);
    const bytes = await fs.readFile(absolute);
    return new Response(bytes, {
      headers: {
        "Content-Type": mimeTypeFor(relative),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read blob";
    return new Response(message, { status: 500 });
  }
}
