"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SettingsLayout } from "@/components/settings/SettingsLayout";
import { SettingsSelect } from "@/components/settings/SettingsSelect";

type DetectedAuth = {
  sourcePath: string;
  exists: boolean;
  mode: "api-key" | "oauth" | null;
  modeRaw: string | null;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  hasTokens: boolean;
  accountId: string | null;
  email?: string | null;
  name?: string | null;
  planType?: string | null;
  accountKind?: string | null;
  lastRefresh: string | null;
  lastRefreshAttemptAt?: string | null;
  refreshError?: string | null;
  baseUrl?: string;
  error?: string;
};

export default function SettingsAuthPage() {
  const router = useRouter();
  const [mode, setMode] = useState("api-key");
  const [keyName, setKeyName] = useState("");
  const [keys, setKeys] = useState<Array<{ id: string; name: string; createdAt: string }>>([]);
  const [detected, setDetected] = useState<DetectedAuth | null>(null);
  const [message, setMessage] = useState("");
  const [oauthMethod, setOauthMethod] = useState<"callback" | "device">("callback");
  const [oauthFlow, setOauthFlow] = useState<{ verificationUrl: string; userCode: string; requestId: string; interval?: number; kind: "callback" | "device" } | null>(null);
  const [oauthPolling, setOauthPolling] = useState(false);
  const [nextPollIn, setNextPollIn] = useState(0);

  async function load() {
    const data = await fetch("/api/settings/auth").then((response) => response.json());
    setMode(data.mode ?? "api-key");
    setKeys(data.apiKeys ?? []);
    setDetected(data.detected ?? null);
  }

  useEffect(() => { void load(); }, []);

  async function patch(body: Record<string, string>) {
    const response = await fetch("/api/settings/auth", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error ?? "Auth action failed");
      return;
    }
    setMode(data.mode ?? "api-key");
    setKeys(data.apiKeys ?? []);
    await load();
  }

  async function logout() {
    await patch({ action: "logout" });
    router.replace("/login");
  }

  async function retryRefresh() {
    const response = await fetch("/api/settings/auth", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "oauth-refresh" }),
    });
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error ?? "OAuth refresh failed");
      return;
    }
    setMessage("OAuth refresh success");
    await load();
  }

  async function reloginOauth() {
    if (oauthMethod === "callback") {
      const response = await fetch("/api/settings/auth", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "oauth-callback-start" }),
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(data.error ?? "Failed to start OAuth callback");
        return;
      }
      setOauthFlow({
        verificationUrl: data.authorizeUrl,
        userCode: "",
        requestId: data.requestId,
        interval: 3,
        kind: "callback",
      });
      setNextPollIn(3);
      setMessage("OAuth callback flow started");
      window.open(data.authorizeUrl, "_blank", "noopener,noreferrer");
      return;
    }
    const response = await fetch("/api/settings/auth", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "oauth-device-start" }),
    });
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error ?? "Failed to start OAuth re-login");
      return;
    }
    setOauthFlow({
      verificationUrl: data.verificationUrl,
      userCode: data.userCode,
      requestId: data.requestId,
      interval: Number(data.interval || 5),
      kind: "device",
    });
    setNextPollIn(Number(data.interval || 5));
    setMessage("OAuth device flow started");
  }

  async function importOauthFromCodex() {
    const response = await fetch("/api/settings/auth", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "oauth-import-codex" }),
    });
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error ?? "Import OAuth Codex gagal");
      return;
    }
    setMessage("OAuth imported from Codex");
    await load();
  }

  async function checkOauthDeviceFlow() {
    if (!oauthFlow?.requestId) return;
    setOauthPolling(true);
    const response = await fetch("/api/settings/auth", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: oauthFlow.kind === "callback" ? "oauth-callback-poll" : "oauth-device-poll",
        requestId: oauthFlow.requestId,
      }),
    });
    const data = await response.json();
    if (response.status === 202 || data.status === "pending") {
      const nextInterval = Number(data.interval || oauthFlow.interval || 5);
      setNextPollIn(nextInterval);
      setMessage("Menunggu verifikasi...");
      setOauthPolling(false);
      return;
    }
    if (!response.ok) {
      setMessage(data.error ?? "OAuth device flow gagal");
      setOauthPolling(false);
      return;
    }
    setOauthPolling(false);
    setMessage("OAuth login success");
    setOauthFlow(null);
    setNextPollIn(0);
    await load();
  }

  useEffect(() => {
    if (!oauthFlow?.requestId) return;
    const intervalMs = Math.max(3, oauthFlow.interval || 5) * 1000;
    const timer = window.setInterval(() => {
      if (!oauthPolling) void checkOauthDeviceFlow();
    }, intervalMs);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oauthFlow?.requestId, oauthFlow?.interval, oauthPolling]);

  useEffect(() => {
    if (!oauthFlow?.requestId) return;
    setNextPollIn(Math.max(1, oauthFlow.interval || 5));
    const timer = window.setInterval(() => {
      setNextPollIn((value) => Math.max(0, value - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [oauthFlow?.requestId, oauthFlow?.interval]);

  return (
    <SettingsLayout title="Auth">
      <div className="panel-card mb-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Detected FCode auth</p>
            <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>{detected?.sourcePath ?? "~/.fencode/auth.json"}</p>
          </div>
          <span className="rounded-full border px-2.5 py-1 text-xs font-medium" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
            {detected?.mode === "api-key" ? "API Key" : detected?.mode === "oauth" ? "OAuth" : "Unknown"}
          </span>
        </div>
        {!detected?.exists ? (
          <p className="text-sm" style={{ color: "var(--muted)" }}>File auth belum ada.</p>
        ) : (
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <div><span style={{ color: "var(--muted)" }}>Auth mode:</span> {detected?.modeRaw ?? "-"}</div>
            <div><span style={{ color: "var(--muted)" }}>API key:</span> {detected?.hasApiKey ? detected.apiKeyMasked : "Not found"}</div>
            <div><span style={{ color: "var(--muted)" }}>Tokens:</span> {detected?.hasTokens ? "Available" : "Not found"}</div>
            <div><span style={{ color: "var(--muted)" }}>Account:</span> {detected?.accountId ?? "-"}</div>
            <div><span style={{ color: "var(--muted)" }}>Email:</span> {detected?.email ?? "-"}</div>
            <div><span style={{ color: "var(--muted)" }}>Name:</span> {detected?.name ?? "-"}</div>
            <div><span style={{ color: "var(--muted)" }}>Plan:</span> {detected?.planType ?? "-"}</div>
            <div><span style={{ color: "var(--muted)" }}>Kind:</span> {detected?.accountKind ?? "-"}</div>
            <div><span style={{ color: "var(--muted)" }}>Base URL:</span> {detected?.baseUrl ?? "https://api.openai.com/v1"}</div>
            <div className="sm:col-span-2"><span style={{ color: "var(--muted)" }}>Last refresh:</span> {detected?.lastRefresh ?? "-"}</div>
            <div className="sm:col-span-2"><span style={{ color: "var(--muted)" }}>Refresh status:</span> {detected?.refreshError ? `Failed (${detected.refreshError})` : detected?.lastRefreshAttemptAt ? "OK" : "-"}</div>
            {detected?.error ? <div className="sm:col-span-2 text-sm text-red-400">{detected.error}</div> : null}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <button className="danger-button" onClick={() => void logout()}>Logout</button>
          <button className="ghost-button" onClick={() => router.push("/login")}>Switch login</button>
          {mode === "oauth" ? <button className="ghost-button" onClick={() => void retryRefresh()}>Retry refresh</button> : null}
          {mode === "oauth" ? <button className="ghost-button" onClick={() => void reloginOauth()}>Re-login OAuth</button> : null}
          {mode === "oauth" ? <button className="ghost-button" onClick={() => void importOauthFromCodex()}>Import from Codex</button> : null}
        </div>
        {message ? <p className="text-sm text-red-400">{message}</p> : null}
        {mode === "oauth" ? (
          <div className="flex gap-2 text-sm">
            <button className={`pill ${oauthMethod === "callback" ? "active" : ""}`} onClick={() => setOauthMethod("callback")}>Callback</button>
            <button className={`pill ${oauthMethod === "device" ? "active" : ""}`} onClick={() => setOauthMethod("device")}>Device</button>
          </div>
        ) : null}
        {oauthFlow ? (
          <div className="grid gap-2 text-sm sm:grid-cols-1">
            <div>
              <span style={{ color: "var(--muted)" }}>Verification URL:</span>{" "}
              <a className="break-all underline" href={oauthFlow.verificationUrl} target="_blank" rel="noopener noreferrer">{oauthFlow.verificationUrl}</a>
            </div>
            {oauthFlow.kind === "device" ? <div><span style={{ color: "var(--muted)" }}>User code:</span> {oauthFlow.userCode}</div> : null}
            <div><span style={{ color: "var(--muted)" }}>Next check:</span> {oauthPolling ? "checking..." : `${nextPollIn}s`}</div>
            <div className="flex flex-wrap gap-2">
              <button className="ghost-button" onClick={() => window.open(oauthFlow.verificationUrl, "_blank", "noopener,noreferrer")}>Open verification URL</button>
              {oauthFlow.kind === "device" ? (
                <button className="ghost-button" onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(oauthFlow.userCode);
                    setMessage("User code copied");
                  } catch {
                    setMessage("Failed to copy code");
                  }
                }}>Copy code</button>
              ) : null}
              <button className="ghost-button" onClick={() => void checkOauthDeviceFlow()}>{oauthPolling ? "Checking..." : "I already verified, check now"}</button>
            </div>
          </div>
        ) : null}
      </div>
      <label className="config-field">
        <span>Auth mode</span>
        <SettingsSelect
          value={mode}
          items={[
            { value: "api-key", label: "API Key" },
            { value: "oauth", label: "OAuth" },
          ]}
          onChange={(value) => void patch({ mode: value })}
        />
      </label>
      {mode === "api-key" ? (
        <div className="mt-4">
          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
            <input className="config-input" value={keyName} onChange={(event) => setKeyName(event.target.value)} placeholder="Key name" />
            <button className="primary-button" onClick={async () => { if (keyName.trim()) await patch({ addKeyName: keyName }); setKeyName(""); }}>Add key</button>
          </div>
          <div className="mt-4 space-y-2">{keys.map((key) => <div key={key.id} className="panel-card">{key.name} · {(key as { masked?: string }).masked ?? `****${key.id.slice(-4)}`}</div>)}</div>
        </div>
      ) : <p className="mt-4 text-sm" style={{ color: "var(--muted)" }}>OAuth active. Provider base URL is locked to OpenAI.</p>}
      {mode === "oauth" ? (
        <p className="mt-3 text-sm" style={{ color: "var(--muted)" }}>
          OAuth memakai token di active FenCode auth.json. Import dari ~/.codex/auth.json tetap ada, tapi manual dan opsional.
        </p>
      ) : null}
    </SettingsLayout>
  );
}
