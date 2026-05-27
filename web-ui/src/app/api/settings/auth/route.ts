import { NextResponse } from "next/server";
import { z } from "zod";
import { addApiKey, deleteApiKey, readAuthSettings, writeAuthSettings } from "@/lib/db";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { resolveFencodeHome } from "@/lib/runtimeHome";

const schema = z.object({
  mode: z.enum(["api-key", "oauth"]).optional(),
  addKeyName: z.string().optional(),
  deleteKeyId: z.string().optional(),
  action: z.enum(["logout", "api-key", "oauth", "oauth-import-codex", "oauth-refresh", "oauth-device-start", "oauth-device-poll", "oauth-callback-start", "oauth-callback-poll"]).optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  requestId: z.string().optional(),
});

type FcodeAuthFile = {
  auth_mode?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  openai_base_url?: string;
  base_url?: string;
  tokens?: { account_id?: string; access_token?: string; refresh_token?: string; id_token?: string };
  last_refresh?: string;
  oauth_refresh_attempt_at?: string;
  oauth_refresh_error?: string;
};

type DeviceFlowState = {
  requestId: string;
  issuer: string;
  clientId: string;
  verificationUrl: string;
  userCode: string;
  deviceAuthId: string;
  interval: number;
  codeVerifier: string;
  createdAt: number;
};

type CallbackFlowState = {
  requestId: string;
  issuer: string;
  clientId: string;
  redirectUri: string;
  authorizeUrl: string;
  codeVerifier: string;
  state: string;
  createdAt: number;
  status: "pending" | "completed" | "error";
  error?: string;
};

const DEVICE_FLOW_TTL_MS = 15 * 60 * 1000;
const DEFAULT_ISSUER = "https://auth.openai.com";
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const CALLBACK_REDIRECT_URI = "http://localhost:1455/auth/callback";
const deviceFlows = new Map<string, DeviceFlowState>();
const callbackFlows = new Map<string, CallbackFlowState>();
let callbackServerStarted = false;

export const runtime = "nodejs";

function authPath() {
  return path.join(resolveFencodeHome(), "auth.json");
}

function codexAuthPath() {
  const home = process.env.CODEX_HOME || path.join(".codex");
  return path.join(home, "auth.json");
}

function maskApiKey(value: string) {
  if (value.length <= 10) return `${value.slice(0, 3)}***`;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function readDetectedAuth() {
  const filePath = authPath();
  if (!fs.existsSync(filePath)) {
    return {
      sourcePath: filePath,
      exists: false,
      mode: null,
      modeRaw: null,
      hasApiKey: false,
      apiKeyMasked: null,
      hasTokens: false,
      accountId: null,
      lastRefresh: null,
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as FcodeAuthFile;
    const modeRaw = (raw.auth_mode ?? "").toLowerCase();
    const hasApiKey = Boolean(raw.OPENAI_API_KEY?.trim());
    const hasTokens = Boolean(raw.tokens?.account_id);
    const identity = tokenIdentity(raw.tokens?.id_token || raw.tokens?.access_token || "");
    const mode = modeRaw === "apikey" || modeRaw === "api-key" || hasApiKey ? "api-key" : hasTokens ? "oauth" : null;
    const baseUrl = raw.OPENAI_BASE_URL || raw.openai_base_url || raw.base_url || "https://api.openai.com/v1";
    return {
      sourcePath: filePath,
      exists: true,
      mode,
      modeRaw: modeRaw || null,
      hasApiKey,
      apiKeyMasked: hasApiKey ? maskApiKey(raw.OPENAI_API_KEY as string) : null,
      hasTokens,
      accountId: raw.tokens?.account_id ?? null,
      email: identity.email ?? null,
      name: identity.name ?? null,
      planType: identity.planType ?? null,
      accountKind: identity.accountKind ?? null,
      lastRefresh: raw.last_refresh ?? null,
      lastRefreshAttemptAt: raw.oauth_refresh_attempt_at ?? null,
      refreshError: raw.oauth_refresh_error ?? null,
      baseUrl,
    };
  } catch {
    return {
      sourcePath: filePath,
      exists: true,
      mode: null,
      modeRaw: null,
      hasApiKey: false,
      apiKeyMasked: null,
      hasTokens: false,
      accountId: null,
      lastRefresh: null,
      lastRefreshAttemptAt: null,
      refreshError: null,
      error: "Failed to parse auth.json",
    };
  }
}

function tokenIdentity(jwt: string) {
  const parts = jwt.split(".");
  if (parts.length < 2) return { email: undefined, name: undefined, planType: undefined, accountKind: undefined };
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      email?: string;
      name?: string;
      "https://api.openai.com/auth"?: { chatgpt_plan_type?: string };
      chatgpt_plan_type?: string;
    };
    const planType = payload["https://api.openai.com/auth"]?.chatgpt_plan_type || payload.chatgpt_plan_type;
    const normalized = (planType || "").toLowerCase();
    const accountKind = /(team|business|enterprise|edu|workspace)/.test(normalized) ? "workspace/business" : planType ? "personal" : undefined;
    return { email: payload.email, name: payload.name, planType, accountKind };
  } catch {
    return { email: undefined, name: undefined, planType: undefined, accountKind: undefined };
  }
}

function writeApiKeyAuth(apiKey: string, baseUrl?: string) {
  const cleanKey = apiKey.trim();
  if (!cleanKey) throw new Error("API key kosong");
  const cleanBaseUrl = (baseUrl?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  const filePath = authPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    auth_mode: "apikey",
    OPENAI_API_KEY: cleanKey,
    OPENAI_BASE_URL: cleanBaseUrl,
    last_refresh: new Date().toISOString(),
  }, null, 2));
}

function logoutAuth() {
  const filePath = authPath();
  if (!fs.existsSync(filePath)) return;
  const backup = path.join(path.dirname(filePath), `auth.logged-out.${Date.now()}.json`);
  fs.renameSync(filePath, backup);
}

function switchToOauthIfAvailable() {
  const filePath = authPath();
  if (!fs.existsSync(filePath)) return false;
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as FcodeAuthFile;
  if (!raw.tokens?.account_id) return false;
  delete raw.OPENAI_API_KEY;
  raw.auth_mode = "chatgpt";
  raw.last_refresh = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(raw, null, 2));
  return true;
}

function importOauthFromCodexAuth() {
  const sourcePath = codexAuthPath();
  if (!fs.existsSync(sourcePath)) return { ok: false as const, reason: "missing-codex-auth" };
  const source = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as FcodeAuthFile;
  if (!source.tokens?.account_id || !source.tokens?.access_token) {
    return { ok: false as const, reason: "missing-codex-oauth-token" };
  }
  const targetPath = authPath();
  const current = fs.existsSync(targetPath)
    ? (JSON.parse(fs.readFileSync(targetPath, "utf8")) as FcodeAuthFile)
    : {};
  const merged: FcodeAuthFile = {
    ...current,
    auth_mode: "chatgpt",
    tokens: {
      account_id: source.tokens.account_id,
      access_token: source.tokens.access_token,
      refresh_token: source.tokens.refresh_token,
      id_token: source.tokens.id_token,
    },
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    openai_base_url: "https://api.openai.com/v1",
    base_url: "https://api.openai.com/v1",
    last_refresh: new Date().toISOString(),
  };
  delete merged.OPENAI_API_KEY;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(merged, null, 2));
  return { ok: true as const, sourcePath };
}

async function startNativeOauthDeviceFlow() {
  const issuer = DEFAULT_ISSUER;
  const clientId = DEFAULT_CLIENT_ID;
  const response = await fetch(`${issuer}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId }),
  });
  if (!response.ok) {
    throw new Error(`Device code request failed (${response.status})`);
  }
  const payload = await response.json() as {
    device_auth_id?: string;
    user_code?: string;
    usercode?: string;
    interval?: string | number;
  };
  const requestId = `oauth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pkce = generatePkceCodes();
  const interval = Math.max(3, Number(payload.interval || 5));
  const userCode = payload.user_code || payload.usercode || "";
  const deviceAuthId = payload.device_auth_id || "";
  if (!userCode || !deviceAuthId) throw new Error("Device code response incomplete");
  const flow: DeviceFlowState = {
    requestId,
    issuer,
    clientId,
    verificationUrl: `${issuer}/codex/device`,
    userCode,
    deviceAuthId,
    interval,
    codeVerifier: pkce.codeVerifier,
    createdAt: Date.now(),
  };
  deviceFlows.set(requestId, flow);
  return flow;
}

async function pollNativeOauthDeviceFlow(requestId: string) {
  const flow = deviceFlows.get(requestId);
  if (!flow) return { status: "missing" as const };
  if (Date.now() - flow.createdAt > DEVICE_FLOW_TTL_MS) {
    deviceFlows.delete(requestId);
    return { status: "expired" as const };
  }
  const response = await fetch(`${flow.issuer}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device_auth_id: flow.deviceAuthId,
      user_code: flow.userCode,
    }),
  });
  if (response.status === 403 || response.status === 404) {
    return { status: "pending" as const, interval: flow.interval };
  }
  if (!response.ok) {
    return { status: "error" as const, error: `Device auth failed (${response.status})` };
  }
  const codePayload = await response.json() as {
    authorization_code?: string;
    code_verifier?: string;
  };
  const authorizationCode = codePayload.authorization_code || "";
  const codeVerifier = codePayload.code_verifier || flow.codeVerifier;
  if (!authorizationCode) return { status: "error" as const, error: "Authorization code missing" };

  const tokenResponse = await fetch(`${flow.issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: `${flow.issuer}/deviceauth/callback`,
      client_id: flow.clientId,
      code_verifier: codeVerifier,
    }),
  });
  if (!tokenResponse.ok) {
    return { status: "error" as const, error: `Token exchange failed (${tokenResponse.status})` };
  }
  const tokens = await tokenResponse.json() as {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
  };
  if (!tokens.access_token) return { status: "error" as const, error: "Access token missing" };
  persistOauthTokens(tokens);
  deviceFlows.delete(requestId);
  return { status: "completed" as const };
}

function ensureCallbackServer() {
  if (callbackServerStarted) return;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost:1455");
      if (url.pathname !== "/auth/callback") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const state = url.searchParams.get("state") || "";
      const code = url.searchParams.get("code") || "";
      const oauthError = url.searchParams.get("error") || "";
      const flow = [...callbackFlows.values()].find((item) => item.state === state && item.status === "pending");
      if (!flow) {
        res.statusCode = 400;
        res.end("invalid oauth state");
        return;
      }
      if (oauthError) {
        flow.status = "error";
        flow.error = oauthError;
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end("<h3>OAuth failed</h3><p>Return to FCode and retry.</p>");
        return;
      }
      if (!code) {
        flow.status = "error";
        flow.error = "missing_code";
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end("<h3>OAuth failed</h3><p>Missing authorization code.</p>");
        return;
      }
      try {
        const tokenResponse = await fetch(`${flow.issuer}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: flow.redirectUri,
            client_id: flow.clientId,
            code_verifier: flow.codeVerifier,
          }),
        });
        if (!tokenResponse.ok) {
          flow.status = "error";
          flow.error = `token_exchange_${tokenResponse.status}`;
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end("<h3>OAuth failed</h3><p>Token exchange failed. Back to FCode.</p>");
          return;
        }
        const tokens = await tokenResponse.json() as { id_token?: string; access_token?: string; refresh_token?: string };
        if (!tokens.access_token) {
          flow.status = "error";
          flow.error = "missing_access_token";
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end("<h3>OAuth failed</h3><p>Missing access token. Back to FCode.</p>");
          return;
        }
        persistOauthTokens(tokens);
        flow.status = "completed";
        flow.error = "";
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end("<h3>OAuth success</h3><p>Return to FCode. You can close this tab.</p>");
      } catch {
        flow.status = "error";
        flow.error = "token_exchange_network_error";
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end("<h3>OAuth failed</h3><p>Network error. Back to FCode and retry.</p>");
      }
    } catch {
      res.statusCode = 500;
      res.end("callback server error");
    }
  });
  server.listen(1455, "127.0.0.1");
  callbackServerStarted = true;
}

function startOauthCallbackFlow() {
  ensureCallbackServer();
  const issuer = DEFAULT_ISSUER;
  const clientId = DEFAULT_CLIENT_ID;
  const pkce = generatePkceCodes();
  const requestId = `oauth-cb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const state = crypto.randomBytes(32).toString("base64url");
  const authorizeUrl = `${issuer}/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK_REDIRECT_URI,
    scope: "openid profile email offline_access",
    code_challenge: pkce.codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
    state,
  }).toString()}`;
  callbackFlows.set(requestId, {
    requestId,
    issuer,
    clientId,
    redirectUri: CALLBACK_REDIRECT_URI,
    authorizeUrl,
    codeVerifier: pkce.codeVerifier,
    state,
    createdAt: Date.now(),
    status: "pending",
  });
  return { requestId, authorizeUrl, redirectUri: CALLBACK_REDIRECT_URI };
}

function pollOauthCallbackFlow(requestId: string) {
  const flow = callbackFlows.get(requestId);
  if (!flow) return { status: "missing" as const };
  if (Date.now() - flow.createdAt > DEVICE_FLOW_TTL_MS) {
    callbackFlows.delete(requestId);
    return { status: "expired" as const };
  }
  if (flow.status === "completed") {
    callbackFlows.delete(requestId);
    return { status: "completed" as const };
  }
  if (flow.status === "error") {
    const error = flow.error || "oauth_callback_failed";
    callbackFlows.delete(requestId);
    return { status: "error" as const, error };
  }
  return { status: "pending" as const };
}

async function refreshOauthNow() {
  const targetPath = authPath();
  if (!fs.existsSync(targetPath)) throw new Error("auth.json not found");
  const current = JSON.parse(fs.readFileSync(targetPath, "utf8")) as FcodeAuthFile;
  const refreshToken = current.tokens?.refresh_token?.trim();
  if (!refreshToken) throw new Error("refresh_token not found");
  const response = await fetch(`${DEFAULT_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: DEFAULT_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) {
    const fail: FcodeAuthFile = {
      ...current,
      oauth_refresh_attempt_at: new Date().toISOString(),
      oauth_refresh_error: `refresh_http_${response.status}`,
    };
    fs.writeFileSync(targetPath, JSON.stringify(fail, null, 2));
    throw new Error(`refresh failed (${response.status})`);
  }
  const refreshed = await response.json() as { access_token?: string; refresh_token?: string; id_token?: string };
  if (!refreshed.access_token) throw new Error("refresh response missing access_token");
  const next: FcodeAuthFile = {
    ...current,
    auth_mode: "chatgpt",
    tokens: {
      ...current.tokens,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token || refreshToken,
      id_token: refreshed.id_token || current.tokens?.id_token,
    },
    OPENAI_BASE_URL: OPENAI_BASE_URL,
    openai_base_url: OPENAI_BASE_URL,
    base_url: OPENAI_BASE_URL,
    last_refresh: new Date().toISOString(),
    oauth_refresh_attempt_at: new Date().toISOString(),
    oauth_refresh_error: "",
  };
  delete next.OPENAI_API_KEY;
  fs.writeFileSync(targetPath, JSON.stringify(next, null, 2));
}

function persistOauthTokens(tokens: { id_token?: string; access_token?: string; refresh_token?: string }) {
  const targetPath = authPath();
  const current = fs.existsSync(targetPath)
    ? (JSON.parse(fs.readFileSync(targetPath, "utf8")) as FcodeAuthFile)
    : {};
  const next: FcodeAuthFile = {
    ...current,
    auth_mode: "chatgpt",
    tokens: {
      account_id: current.tokens?.account_id || accountIdFromJwt(tokens.id_token || tokens.access_token || ""),
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      id_token: tokens.id_token,
    },
    OPENAI_BASE_URL: OPENAI_BASE_URL,
    openai_base_url: OPENAI_BASE_URL,
    base_url: OPENAI_BASE_URL,
    last_refresh: new Date().toISOString(),
  };
  delete next.OPENAI_API_KEY;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(next, null, 2));
}

function generatePkceCodes() {
  const codeVerifier = crypto.randomBytes(64).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

function accountIdFromJwt(jwt: string) {
  const parts = jwt.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      "https://api.openai.com/auth"?: { chatgpt_account_id?: string };
      chatgpt_account_id?: string;
    };
    return payload["https://api.openai.com/auth"]?.chatgpt_account_id || payload.chatgpt_account_id;
  } catch {
    return undefined;
  }
}

export async function GET() {
  return NextResponse.json({
    ...readAuthSettings(),
    detected: readDetectedAuth(),
  });
}

export async function PATCH(request: Request) {
  const body = schema.parse(await request.json());
  if (body.action === "logout") {
    logoutAuth();
    return NextResponse.json({
      ...writeAuthSettings({ mode: "api-key" }),
      detected: readDetectedAuth(),
    });
  }
  if (body.action === "api-key") {
    try {
      writeApiKeyAuth(body.apiKey ?? "", body.baseUrl);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to save API key" }, { status: 400 });
    }
    return NextResponse.json({
      ...writeAuthSettings({ mode: "api-key" }),
      detected: readDetectedAuth(),
    });
  }
  if (body.action === "oauth") {
    if (switchToOauthIfAvailable()) {
      return NextResponse.json({
        ...writeAuthSettings({ mode: "oauth" }),
        detected: readDetectedAuth(),
        source: "fencode-auth",
      });
    }
    return NextResponse.json({
      error: "OAuth token belum ada di active FenCode auth.json.",
      oauthNativeRequired: true,
      next: "Start native OAuth device flow.",
    }, { status: 409 });
  }
  if (body.action === "oauth-import-codex") {
    const imported = importOauthFromCodexAuth();
    if (!imported.ok) {
      return NextResponse.json({ error: "OAuth Codex tidak ditemukan atau token tidak lengkap." }, { status: 409 });
    }
    return NextResponse.json({
      ...writeAuthSettings({ mode: "oauth" }),
      detected: readDetectedAuth(),
      source: "codex-import",
      sourcePath: imported.sourcePath,
    });
  }
  if (body.action === "oauth-refresh") {
    try {
      await refreshOauthNow();
      return NextResponse.json({
        ...writeAuthSettings({ mode: "oauth" }),
        detected: readDetectedAuth(),
        status: "refreshed",
      });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "oauth refresh failed" }, { status: 409 });
    }
  }
  if (body.action === "oauth-device-start") {
    try {
      const flow = await startNativeOauthDeviceFlow();
      return NextResponse.json({
        ok: true,
        requestId: flow.requestId,
        verificationUrl: flow.verificationUrl,
        userCode: flow.userCode,
        interval: flow.interval,
      });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to start native OAuth" }, { status: 400 });
    }
  }
  if (body.action === "oauth-device-poll") {
    if (!body.requestId?.trim()) {
      return NextResponse.json({ error: "requestId is required" }, { status: 400 });
    }
    const result = await pollNativeOauthDeviceFlow(body.requestId.trim());
    if (result.status === "completed") {
      return NextResponse.json({
        ...writeAuthSettings({ mode: "oauth" }),
        detected: readDetectedAuth(),
        source: "native-device-flow",
        status: "completed",
      });
    }
    return NextResponse.json(result, { status: result.status === "pending" ? 202 : 409 });
  }
  if (body.action === "oauth-callback-start") {
    try {
      const flow = startOauthCallbackFlow();
      return NextResponse.json({
        ok: true,
        requestId: flow.requestId,
        authorizeUrl: flow.authorizeUrl,
        redirectUri: flow.redirectUri,
      });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to start callback OAuth" }, { status: 400 });
    }
  }
  if (body.action === "oauth-callback-poll") {
    if (!body.requestId?.trim()) {
      return NextResponse.json({ error: "requestId is required" }, { status: 400 });
    }
    const result = pollOauthCallbackFlow(body.requestId.trim());
    if (result.status === "completed") {
      return NextResponse.json({
        ...writeAuthSettings({ mode: "oauth" }),
        detected: readDetectedAuth(),
        source: "callback-flow",
        status: "completed",
      });
    }
    return NextResponse.json(result, { status: result.status === "pending" ? 202 : 409 });
  }
  if (body.addKeyName) addApiKey(body.addKeyName);
  if (body.deleteKeyId) deleteApiKey(body.deleteKeyId);
  return NextResponse.json(writeAuthSettings({ mode: body.mode }));
}
