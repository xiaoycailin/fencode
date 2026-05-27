import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { NextResponse } from "next/server";

type PackageMeta = {
  name: string;
  version: string;
};

const fallbackMeta: PackageMeta = {
  name: "@aiden2209/fencode",
  version: "0.0.0",
};

export async function GET() {
  const meta = readPackageMeta();

  try {
    const latest = readLatestVersion(meta.name);
    return NextResponse.json({
      packageName: meta.name,
      currentVersion: meta.version,
      latestVersion: latest,
      hasUpdate: compareSemver(latest, meta.version) > 0,
      updateCommand: `npm i -g ${meta.name}@latest`,
    });
  } catch (error) {
    return NextResponse.json({
      packageName: meta.name,
      currentVersion: meta.version,
      latestVersion: null,
      hasUpdate: false,
      updateCommand: `npm i -g ${meta.name}@latest`,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function POST() {
  const meta = readPackageMeta();
  const result = runNpm(["i", "-g", `${meta.name}@latest`], 120_000);
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (result.status !== 0) {
    return NextResponse.json({ ok: false, output: output || "npm update failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, output });
}

function readPackageMeta(): PackageMeta {
  const packagePath = path.resolve(process.cwd(), "package.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as Partial<PackageMeta>;
    return {
      name: String(parsed.name || fallbackMeta.name),
      version: String(parsed.version || fallbackMeta.version),
    };
  } catch {
    return fallbackMeta;
  }
}

function readLatestVersion(packageName: string) {
  const result = runNpm(["view", packageName, "version", "--json"]);
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || "npm view failed").trim());
  }
  const raw = String(result.stdout || "").trim();
  if (!raw) throw new Error("empty npm response");
  try {
    const parsed = JSON.parse(raw) as string | string[];
    if (Array.isArray(parsed)) return String(parsed[parsed.length - 1] || "").trim();
    return String(parsed || "").trim();
  } catch {
    return raw;
  }
}

function runNpm(args: string[], timeout = 30_000) {
  if (process.platform !== "win32") {
    return spawnSync("npm", args, { encoding: "utf8", windowsHide: true, timeout });
  }
  return spawnSync("cmd.exe", ["/d", "/s", "/c", ["npm", ...args].join(" ")], {
    encoding: "utf8",
    windowsHide: true,
    timeout,
  });
}

function compareSemver(a: string, b: string) {
  const left = String(a).replace(/^v/i, "").split(".").map((value) => Number(value));
  const right = String(b).replace(/^v/i, "").split(".").map((value) => Number(value));
  for (let index = 0; index < 3; index += 1) {
    const av = Number.isFinite(left[index]) ? left[index] : 0;
    const bv = Number.isFinite(right[index]) ? right[index] : 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}
