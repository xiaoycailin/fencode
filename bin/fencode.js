#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const argv = process.argv.slice(2);
const rawCommand = (argv[0] || "help").toLowerCase();
const command = rawCommand === "--version" || rawCommand === "-v" ? "version" : rawCommand;
const rest = argv.slice(1);

const FENCODE_HOME = resolveFencodeHome();
const RUNTIME_DIR = path.join(FENCODE_HOME, "runtime");
const STATE_PATH = path.join(RUNTIME_DIR, "launcher-state.json");
const CONFIG_PATH = path.join(FENCODE_HOME, "config.json");
const CHILD_STATE_PATH = path.join(RUNTIME_DIR, "launcher-children.json");
const ROOT_PACKAGE_PATH = path.resolve(__dirname, "..", "package.json");
const AUTO_START_REG_PATH = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const AUTO_START_REG_NAME = "FenCode";

const DEFAULT_AP = 32188;
const DEFAULT_UI = 25874;
const COLOR = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
};

function color(value, code) {
  return `${code}${value}${COLOR.reset}`;
}

function resolveFencodeHome() {
  if (process.env.FENCODE_HOME && process.env.FENCODE_HOME.trim()) return process.env.FENCODE_HOME.trim();
  return path.join(os.homedir(), isSourceCheckout() ? ".fencode-dev" : ".fencode");
}

function isSourceCheckout() {
  let cursor = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (hasSourceLayout(cursor)) {
      return true;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return false;
}

function hasSourceLayout(root) {
  return fs.existsSync(path.join(root, "fcode-server", "src"))
    && fs.existsSync(path.join(root, "web-ui", "src"))
    && fs.existsSync(path.join(root, "bin", "fencode.js"));
}

function brand() {
  console.log(`${color("FenCode", COLOR.bold + COLOR.cyan)} ${color("local agent runtime", COLOR.gray)}`);
}

function row(label, value, meta = "") {
  const left = `${label}`.padEnd(12, " ");
  console.log(`${color(left, COLOR.gray)} ${value}${meta ? ` ${color(meta, COLOR.dim)}` : ""}`);
}

function url(value) {
  return color(value, COLOR.green);
}

function ensureDirs() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.mkdirSync(FENCODE_HOME, { recursive: true });
}

function parsePortArg(list, key, fallback) {
  const index = list.indexOf(key);
  if (index < 0) return fallback;
  if (index + 1 >= list.length) throw new Error(`Missing value for ${key}`);
  const value = Number(list[index + 1]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid integer for ${key}: ${list[index + 1]}`);
  return value;
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  ensureDirs();
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function packageMeta() {
  const fallback = { name: "@aiden2209/fencode", version: "0.0.0" };
  try {
    const parsed = JSON.parse(fs.readFileSync(ROOT_PACKAGE_PATH, "utf8"));
    return {
      name: String(parsed.name || fallback.name),
      version: String(parsed.version || fallback.version),
    };
  } catch {
    return fallback;
  }
}

function readState() {
  return readJson(STATE_PATH);
}

function removeState() {
  if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH);
  if (fs.existsSync(CHILD_STATE_PATH)) fs.unlinkSync(CHILD_STATE_PATH);
}

function isAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid) {
  if (!pid || pid <= 0) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
}

function updateEngineServerUrl(appPort) {
  const current = readJson(CONFIG_PATH) || {
    version: 1,
    createdAt: new Date().toISOString(),
    modelProvider: "9router",
    model: "gpt-5.5",
    personality: "pragmatic",
    reasoningEffort: "medium",
    instructions: "",
    features: { memories: true, allowGlobalScan: false },
    provider: { id: "9router", name: "9Router", baseUrl: "http://127.0.0.1:20128/v1", wireApi: "responses" },
    engineServerUrl: "http://127.0.0.1:32188",
    subagentModel: "",
    projects: [],
  };
  current.engineServerUrl = `http://127.0.0.1:${appPort}`;
  writeJson(CONFIG_PATH, current);
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile() || fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function hasRuntimeLayout(root) {
  const serverSource = path.join(root, "fcode-server", "package.json");
  const uiSource = path.join(root, "web-ui", "package.json");
  const serverBuilt = path.join(root, "fcode-server", "dist", "index.js");
  const packagedServerBuilt = path.join(root, "runtime", "fcode-server", "dist", "index.js");
  const uiStandalone = path.join(root, "web-ui", ".next-v2", "standalone", "server.js");
  const nextBin = path.join(root, "web-ui", "node_modules", "next", "dist", "bin", "next");
  return (
    (fileExists(serverSource) && fileExists(uiSource))
    || ((fileExists(serverBuilt) || fileExists(packagedServerBuilt)) && (fileExists(uiStandalone) || fileExists(nextBin)))
  );
}

function pidsListeningOnPort(port) {
  if (!port || port <= 0) return [];
  if (process.platform === "win32") {
    const script = `$conns = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($conns) { $conns | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique }`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-EncodedCommand", encoded], { encoding: "utf8" });
    if (result.status !== 0) return [];
    return String(result.stdout || "")
      .split(/\r?\n/)
      .map((row) => Number(row.trim()))
      .filter((value) => Number.isInteger(value) && value > 0);
  }
  const result = spawnSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((row) => Number(row.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function killPorts(ports) {
  const seen = new Set();
  for (const port of ports) {
    for (const pid of pidsListeningOnPort(Number(port))) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      killPid(pid);
    }
  }
}

function readChildState() {
  return readJson(CHILD_STATE_PATH);
}

async function waitChildState(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = readChildState();
    if (state && Number(state.appPid || 0) > 0 && Number(state.uiPid || 0) > 0) return state;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return readChildState() || null;
}

function resolveRepoRoot() {
  if (process.env.FENCODE_ROOT && process.env.FENCODE_ROOT.trim()) {
    return process.env.FENCODE_ROOT.trim();
  }
  let cursor = process.cwd();
  while (true) {
    if (hasRuntimeLayout(cursor)) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const fromBin = path.resolve(__dirname, "..");
  if (hasRuntimeLayout(fromBin)) {
    return fromBin;
  }
  throw new Error("Cannot locate repo root. Run command inside project, or set FENCODE_ROOT.");
}

function latestVersion(packageName) {
  const result = runNpm(["view", packageName, "version", "--json"]);
  if (result.status !== 0) {
    const err = String(result.stderr || result.stdout || "").trim() || "npm view failed";
    throw new Error(err);
  }
  const raw = String(result.stdout || "").trim();
  if (!raw) throw new Error("empty npm response");
  let parsed = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {}
  if (Array.isArray(parsed)) return String(parsed[parsed.length - 1] || "").trim();
  return String(parsed || "").trim();
}

function runNpm(args) {
  if (process.platform !== "win32") {
    return spawnSync("npm", args, {
      encoding: "utf8",
      windowsHide: true,
    });
  }
  return spawnSync("cmd.exe", ["/d", "/s", "/c", ["npm", ...args].join(" ")], {
    encoding: "utf8",
    windowsHide: true,
  });
}

function compareSemver(a, b) {
  const pa = String(a).replace(/^v/i, "").split(".").map((x) => Number(x));
  const pb = String(b).replace(/^v/i, "").split(".").map((x) => Number(x));
  for (let i = 0; i < 3; i += 1) {
    const av = Number.isFinite(pa[i]) ? pa[i] : 0;
    const bv = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function spawnDetached(commandName, args, cwd, env, outFile, errFile) {
  if (process.platform === "win32") {
    const child = spawn(commandName, args, {
      cwd,
      env: { ...process.env, ...env },
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return child.pid;
  }

  const outFd = fs.openSync(outFile, "a");
  const errFd = fs.openSync(errFile, "a");
  const child = spawn(commandName, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", outFd, errFd],
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

async function start(list) {
  const appPort = parsePortArg(list, "--ap", DEFAULT_AP);
  const uiPort = parsePortArg(list, "--ui", DEFAULT_UI);
  const state = readState();
  const childState = readChildState();
  const existingSupervisorPid = Number((state && state.supervisorPid) || (childState && childState.supervisorPid) || 0);
  const appPid = Number((state && state.appPid) || (childState && childState.appPid) || 0);
  const uiPid = Number((state && state.uiPid) || (childState && childState.uiPid) || 0);
  if (isAlive(existingSupervisorPid) || isAlive(appPid) || isAlive(uiPid)) {
    console.log(`fencode already running (supervisorPid=${existingSupervisorPid || "n/a"}, appPid=${appPid || "n/a"}, uiPid=${uiPid || "n/a"}). Use 'fencode restart' or 'fencode stop'.`);
    return;
  }
  ensureDirs();
  const root = resolveRepoRoot();
  killPorts([appPort, uiPort]);
  updateEngineServerUrl(appPort);

  const appOut = path.join(RUNTIME_DIR, "app-server.out.log");
  const appErr = path.join(RUNTIME_DIR, "app-server.err.log");
  const uiOut = path.join(RUNTIME_DIR, "web-ui.out.log");
  const uiErr = path.join(RUNTIME_DIR, "web-ui.err.log");

  const nodeBin = process.execPath;
  const supervisor = path.join(root, "bin", "fencode-supervisor.js");
  const supervisorEnv = {
    FENCODE_HOME,
    ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
  };
  const supervisorPid = spawnDetached(nodeBin, [
    supervisor,
    "--root", root,
    "--ap", String(appPort),
    "--ui", String(uiPort),
    "--runtime", RUNTIME_DIR,
  ], root, supervisorEnv, appOut, appErr);

  brand();
  row("state", color("starting", COLOR.yellow), `(supervisor pid=${supervisorPid})`);
  row("app server", url(`http://localhost:${appPort}`), "starting");
  row("web ui", url(`http://localhost:${uiPort}`), "starting");

  writeJson(STATE_PATH, {
    startedAt: new Date().toISOString(),
    root,
    appPort,
    uiPort,
    supervisorPid,
    appPid: 0,
    uiPid: 0,
    logs: { appOut, appErr, uiOut, uiErr },
  });

  console.log("");
  row("state", color("started", COLOR.green), `(supervisor pid=${supervisorPid})`);
  row("app server", url(`http://localhost:${appPort}`));
  row("web ui", url(`http://localhost:${uiPort}`));
  row("next", color("fencode status", COLOR.cyan), "check readiness");
}

function stop() {
  const state = readState();
  const childState = readChildState();
  const supervisorPid = Number((state && state.supervisorPid) || (childState && childState.supervisorPid) || 0);
  const appPid = Number((state && state.appPid) || (childState && childState.appPid) || 0);
  const uiPid = Number((state && state.uiPid) || (childState && childState.uiPid) || 0);
  const appPort = Number((state && state.appPort) || (childState && childState.appPort) || DEFAULT_AP);
  const uiPort = Number((state && state.uiPort) || (childState && childState.uiPort) || DEFAULT_UI);
  if (state) {
    killPid(supervisorPid);
    killPid(appPid);
    killPid(uiPid);
    killPorts([appPort, uiPort, DEFAULT_AP, DEFAULT_UI]);
  } else {
    killPorts([DEFAULT_AP, DEFAULT_UI]);
  }
  removeState();
  console.log("fencode stopped");
}

async function restart(list) {
  stop();
  await new Promise((r) => setTimeout(r, 700));
  await start(list);
}

function status() {
  const state = readState();
  const childState = readChildState();
  const appPort = Number((state && state.appPort) || (childState && childState.appPort) || DEFAULT_AP);
  const uiPort = Number((state && state.uiPort) || (childState && childState.uiPort) || DEFAULT_UI);
  const supervisorPid = Number((state && state.supervisorPid) || (childState && childState.supervisorPid) || 0);
  const appPid = Number((state && state.appPid) || (childState && childState.appPid) || 0);
  const uiPid = Number((state && state.uiPid) || (childState && childState.uiPid) || 0);
  const appListening = pidsListeningOnPort(appPort);
  const uiListening = pidsListeningOnPort(uiPort);
  const appRunning = appListening.length > 0;
  const uiRunning = uiListening.length > 0;

  brand();
  row("supervisor", supervisorPid && isAlive(supervisorPid) ? color("running", COLOR.green) : color("stopped", COLOR.yellow), `(pid=${supervisorPid || "n/a"})`);
  row("app server", appRunning ? color("running", COLOR.green) : color("stopped", COLOR.yellow), `${url(`http://localhost:${appPort}`)} pid=${appPid || appListening[0] || "n/a"}`);
  row("web ui", uiRunning ? color("running", COLOR.green) : color("stopped", COLOR.yellow), `${url(`http://localhost:${uiPort}`)} pid=${uiPid || uiListening[0] || "n/a"}`);
  if (state?.logs || childState) {
    const logs = state?.logs || {};
    row("logs", color(logs.appOut || path.join(RUNTIME_DIR, "app-server.out.log"), COLOR.dim));
    row("", color(logs.uiOut || path.join(RUNTIME_DIR, "web-ui.out.log"), COLOR.dim));
  }
}

function logs(list) {
  const tailIndex = list.indexOf("--tail");
  const tail = tailIndex >= 0 ? Math.max(1, Number(list[tailIndex + 1] || 80)) : 80;
  const appOut = path.join(RUNTIME_DIR, "app-server.out.log");
  const appErr = path.join(RUNTIME_DIR, "app-server.err.log");
  const uiOut = path.join(RUNTIME_DIR, "web-ui.out.log");
  const uiErr = path.join(RUNTIME_DIR, "web-ui.err.log");
  printTail("app stdout", appOut, tail);
  printTail("app stderr", appErr, tail);
  printTail("ui stdout", uiOut, tail);
  printTail("ui stderr", uiErr, tail);
}

function version() {
  const meta = packageMeta();
  console.log(meta.version);
}

function checkUpdate() {
  const meta = packageMeta();
  brand();
  row("package", color(meta.name, COLOR.cyan));
  row("current", color(`v${meta.version}`, COLOR.bold));
  try {
    const latest = latestVersion(meta.name);
    const hasUpdate = compareSemver(latest, meta.version) > 0;
    if (hasUpdate) {
      row("latest", color(`v${latest}`, COLOR.green), color("update available", COLOR.green));
      row("update", color(`npm i -g ${meta.name}@latest`, COLOR.cyan));
    } else {
      row("latest", color(`v${latest}`, COLOR.green), color("up to date", COLOR.green));
    }
  } catch (error) {
    row("latest", color("unknown", COLOR.yellow), color(error instanceof Error ? error.message : String(error), COLOR.dim));
    process.exitCode = 1;
  }
}

function autoStart(list) {
  const hasTrue = list.includes("--true");
  const hasFalse = list.includes("--false");
  if ((hasTrue && hasFalse) || (!hasTrue && !hasFalse)) {
    throw new Error("Use exactly one flag: fencode autostart --true OR fencode autostart --false");
  }
  if (process.platform !== "win32") {
    throw new Error("autostart currently supported on Windows only");
  }
  const launcherPath = path.resolve(__dirname, "..", "fencode.cmd");
  const regArgs = [
    "add",
    AUTO_START_REG_PATH,
    "/v",
    AUTO_START_REG_NAME,
    "/t",
    "REG_SZ",
    "/d",
    `"${launcherPath}" start`,
    "/f",
  ];
  if (hasTrue) {
    const result = spawnSync("reg", regArgs, { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || "failed to enable autostart").trim());
    console.log("fencode autostart enabled");
    return;
  }
  const del = spawnSync("reg", ["delete", AUTO_START_REG_PATH, "/v", AUTO_START_REG_NAME, "/f"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (del.status !== 0) {
    const message = String(del.stderr || del.stdout || "").toLowerCase();
    if (!message.includes("unable to find")) throw new Error(String(del.stderr || del.stdout || "failed to disable autostart").trim());
  }
  console.log("fencode autostart disabled");
}

function printTail(label, file, count) {
  console.log(`\n== ${label}: ${file} ==`);
  if (!fs.existsSync(file)) {
    console.log("(missing)");
    return;
  }
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  console.log(lines.slice(-count).join("\n") || "(empty)");
}

function help() {
  console.log(`fencode command launcher

Usage:
  fencode start [--ap <port>] [--ui <port>]
  fencode status
  fencode check
  fencode logs [--tail <lines>]
  fencode autostart --true
  fencode autostart --false
  fencode version | --version | -v
  fencode stop
  fencode restart [--ap <port>] [--ui <port>]
  fencode help

Defaults:
  --ap ${DEFAULT_AP}
  --ui ${DEFAULT_UI}
`);
}

async function main() {
  try {
    if (command === "start") return await start(rest);
    if (command === "status") return status();
    if (command === "check") return checkUpdate();
    if (command === "logs") return logs(rest);
    if (command === "autostart") return autoStart(rest);
    if (command === "version") return version();
    if (command === "stop") return stop();
    if (command === "restart") return await restart(rest);
    if (command === "help") return help();
    console.error(`Unknown command: ${command}`);
    help();
    process.exitCode = 1;
  } catch (error) {
    console.error(`fencode error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

void main();
