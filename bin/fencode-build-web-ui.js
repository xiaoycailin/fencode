#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const tempFencodeHome = path.join(root, ".tmp-fencode-home");
const tempCodexHome = path.join(root, ".tmp-codex-home");

const result = process.platform === "win32"
  ? spawnSync(
    "cmd.exe",
    [
      "/d",
      "/s",
      "/c",
      `set "FENCODE_HOME=${tempFencodeHome}" && set "CODEX_HOME=${tempCodexHome}" && npm run build --prefix web-ui`,
    ],
    { cwd: root, stdio: "inherit" },
  )
  : spawnSync(
    "npm",
    ["run", "build", "--prefix", "web-ui"],
    {
      cwd: root,
      env: { ...process.env, FENCODE_HOME: tempFencodeHome, CODEX_HOME: tempCodexHome },
      stdio: "inherit",
    },
  );

if (result.error) {
  console.error(`[fencode-build-web-ui] failed: ${result.error.message}`);
  process.exit(1);
}
process.exit(typeof result.status === "number" ? result.status : 1);
