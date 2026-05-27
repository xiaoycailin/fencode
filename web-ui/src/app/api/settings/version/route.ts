import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
  const started = runLauncherUpdate(meta.name);
  if (!started.ok) {
    return NextResponse.json({ ok: false, output: started.output }, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    output: "FenCode update started. The app server and web UI may restart shortly.",
  });
}

function readPackageMeta(): PackageMeta {
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, "package.json"),
    path.resolve(cwd, "..", "package.json"),
    path.resolve(cwd, "..", "..", "package.json"),
    path.resolve(cwd, "..", "..", "..", "package.json"),
    path.resolve(cwd, "..", "..", "..", "..", "package.json"),
  ];
  for (const packagePath of candidates) {
    try {
      if (!fs.existsSync(packagePath)) continue;
      const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as Partial<PackageMeta>;
      const name = String(parsed.name || "").trim();
      const version = String(parsed.version || "").trim();
      if (name === fallbackMeta.name && version) {
        return { name, version };
      }
    } catch {}
  }
  return fallbackMeta;
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

function runLauncherUpdate(packageName: string) {
  const candidateRoots = [
    process.cwd(),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "..", ".."),
    path.resolve(process.cwd(), "..", "..", ".."),
    path.resolve(process.cwd(), "..", "..", "..", ".."),
  ];
  const launcherRoot = candidateRoots.find((root) => fs.existsSync(path.join(root, "bin", "fencode.js")));
  if (launcherRoot) {
    const child = spawn(process.execPath, [path.join(launcherRoot, "bin", "fencode.js"), "update"], {
      cwd: launcherRoot,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, FENCODE_HOME: process.env.FENCODE_HOME || "" },
    });
    child.unref();
    return { ok: true, output: `started fencode update pid=${child.pid || "n/a"}` };
  }
  const result = runNpm(["i", "-g", `${packageName}@latest`], 120_000);
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  return result.status === 0
    ? { ok: true, output }
    : { ok: false, output: output || "npm update failed" };
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
