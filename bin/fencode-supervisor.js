#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const args = parseArgs(process.argv.slice(2));
const root = required("root");
const appPort = required("ap");
const uiPort = required("ui");
const runtimeDir = required("runtime");

fs.mkdirSync(runtimeDir, { recursive: true });

const appOut = path.join(runtimeDir, "app-server.out.log");
const appErr = path.join(runtimeDir, "app-server.err.log");
const uiOut = path.join(runtimeDir, "web-ui.out.log");
const uiErr = path.join(runtimeDir, "web-ui.err.log");
const childState = path.join(runtimeDir, "launcher-children.json");
const launcherState = path.join(runtimeDir, "launcher-state.json");

const children = [];
let heartbeat = null;

function required(key) {
  const value = args[key];
  if (!value) {
    console.error(`Missing --${key}`);
    process.exit(1);
  }
  return value;
}

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i += 1) {
    const value = list[i];
    if (!value.startsWith("--")) continue;
    out[value.slice(2)] = list[i + 1] || "";
    i += 1;
  }
  return out;
}

function fd(file) {
  return fs.openSync(file, "a");
}

function firstExistingFile(paths) {
  for (const file of paths) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return null;
}

function firstExistingDir(paths) {
  for (const dir of paths) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {}
  }
  return null;
}

function startChild(label, command, commandArgs, cwd, env, outFile, errFile) {
  const child = spawn(command, commandArgs, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", fd(outFile), fd(errFile)],
    windowsHide: true,
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    fs.appendFileSync(errFile, `[fencode-supervisor] ${label} exited code=${code} signal=${signal || ""}\n`);
  });
  return child;
}

function writeChildState(app, ui) {
  const snapshot = {
    supervisorPid: process.pid,
    appPid: app.pid,
    uiPid: ui.pid,
    appPort: Number(appPort),
    uiPort: Number(uiPort),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(childState, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  let launcher = {};
  try {
    launcher = JSON.parse(fs.readFileSync(launcherState, "utf8"));
  } catch {}
  fs.writeFileSync(launcherState, `${JSON.stringify({
    ...launcher,
    ...snapshot,
  }, null, 2)}\n`, "utf8");
}

function cleanupState() {
  try {
    if (fs.existsSync(childState)) fs.unlinkSync(childState);
  } catch {}
}

function shutdown() {
  if (heartbeat) clearInterval(heartbeat);
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  cleanupState();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

const nodeBin = process.execPath;
const appEntry = firstExistingFile([
  path.join(root, "fcode-server", "dist", "index.js"),
  path.join(root, "runtime", "fcode-server", "dist", "index.js"),
]);
const appWorkingDir = firstExistingDir([
  path.join(root, "fcode-server"),
  path.join(root, "runtime", "fcode-server"),
]);

if (!appEntry || !appWorkingDir) {
  fs.appendFileSync(appErr, "[fencode-supervisor] app-server runtime not found. Build fcode-server first.\n");
  process.exit(1);
}

const app = startChild(
  "app-server",
  nodeBin,
  [path.basename(appEntry)],
  path.dirname(appEntry),
  { FCODE_SERVER_PORT: String(appPort), FCODE_SERVER_HOST: "127.0.0.1" },
  appOut,
  appErr,
);

const standaloneServer = firstExistingFile([
  path.join(root, "web-ui", ".next-v2", "standalone", "server.js"),
  path.join(root, "web-ui", ".next", "standalone", "server.js"),
]);
const nextBin = firstExistingFile([
  path.join(root, "web-ui", "node_modules", "next", "dist", "bin", "next"),
]);
const uiCommandArgs = standaloneServer
  ? [standaloneServer]
  : [nextBin || "", "start", "-p", String(uiPort), "-H", "127.0.0.1"];
const uiWorkingDir = standaloneServer
  ? path.dirname(standaloneServer)
  : path.join(root, "web-ui");
const uiEnv = {
  NODE_ENV: "production",
  PORT: String(uiPort),
  HOSTNAME: "127.0.0.1",
  FCODE_SERVER_BASE_URL: `http://127.0.0.1:${appPort}`,
  FCODE_BACKEND: "server",
};

if (!standaloneServer && !nextBin) {
  fs.appendFileSync(uiErr, "[fencode-supervisor] web-ui runner not found. Build web-ui first.\n");
  process.exit(1);
}

const ui = startChild(
  "web-ui",
  nodeBin,
  uiCommandArgs,
  uiWorkingDir,
  uiEnv,
  uiOut,
  uiErr,
);

writeChildState(app, ui);
heartbeat = setInterval(() => writeChildState(app, ui), 5000);
