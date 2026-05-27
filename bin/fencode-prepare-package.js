#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const standaloneRoot = path.join(root, "web-ui", ".next-v2", "standalone");
const standaloneDist = path.join(standaloneRoot, ".next-v2");
const packagedServerDist = path.join(root, "runtime", "fcode-server", "dist");

copyTree(path.join(root, "web-ui", ".next-v2", "static"), path.join(standaloneDist, "static"));
copyTree(path.join(root, "web-ui", "public"), path.join(standaloneRoot, "public"));
copyTree(path.join(root, "fcode-server", "dist"), packagedServerDist);

function copyTree(source, target) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to);
      continue;
    }
    fs.copyFileSync(from, to);
  }
}
