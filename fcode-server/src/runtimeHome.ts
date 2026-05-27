import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveFencodeHome() {
  const override = process.env.FENCODE_HOME?.trim();
  if (override) return override;
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

function hasSourceLayout(root: string) {
  return fs.existsSync(path.join(root, "fcode-server", "src"))
    && fs.existsSync(path.join(root, "web-ui", "src"))
    && fs.existsSync(path.join(root, "bin", "fencode.js"));
}
