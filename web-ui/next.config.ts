import type { NextConfig } from "next";
import os from "node:os";
import path from "node:path";

const isDev = process.env.NODE_ENV === "development";
if (!isDev && !process.env.FENCODE_HOME) {
  process.env.FENCODE_HOME = path.join(__dirname, ".fencode-build");
}
const tracedHomeGlobs = [
  path.join(os.homedir(), ".fencode").replace(/\\/g, "/") + "/**/*",
  path.join(os.homedir(), ".fencode-dev").replace(/\\/g, "/") + "/**/*",
  "**/.fencode/**/*",
  "**/.fencode/**",
  "**/.fencode-dev/**/*",
  "**/.fencode-dev/**",
];

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname),
  outputFileTracingExcludes: {
    "/chat": tracedHomeGlobs,
    "/chat/[sessionId]": tracedHomeGlobs,
    "/api/settings/auth": tracedHomeGlobs,
    "/api/settings/config": tracedHomeGlobs,
    "/api/workspace/file": tracedHomeGlobs,
    "/api/workspace/tree": tracedHomeGlobs,
  },
  distDir: isDev ? ".next-v2-dev" : ".next-v2",
  output: isDev ? undefined : "standalone",
};

export default nextConfig;
