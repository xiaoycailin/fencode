"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type DetectedAuth = {
  hasApiKey: boolean;
  hasTokens: boolean;
  baseUrl?: string;
};

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"oauth" | "api-key">("oauth");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [message, setMessage] = useState("");
  const [oauthMethod, setOauthMethod] = useState<"callback" | "device">("callback");
  const [oauthFlow, setOauthFlow] = useState<{
    requestId: string;
    verificationUrl: string;
    userCode?: string;
    interval: number;
    kind: "device" | "callback";
  } | null>(null);
  const [oauthPolling, setOauthPolling] = useState(false);
  const [nextPollIn, setNextPollIn] = useState<number | null>(null);

  useEffect(() => {
    void fetch("/api/settings/auth", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        const detected = data.detected as DetectedAuth | undefined;
        if (detected?.hasApiKey || detected?.hasTokens) {
          router.replace("/chat");
          return;
        }
        if (detected?.baseUrl) setBaseUrl(detected.baseUrl);
      });
  }, [router]);

  async function loginApiKey() {
    const response = await fetch("/api/settings/auth", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "api-key", apiKey, baseUrl }),
    });
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error ?? "Failed to save API key");
      return;
    }
    router.replace("/chat");
  }

  async function loginOauth() {
    setMessage("");
    const response = await fetch("/api/settings/auth", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "oauth" }),
    });
    const data = await response.json();
    if (!response.ok) {
      if (data.oauthNativeRequired) {
        if (oauthMethod === "callback") await startOauthCallbackFlow();
        else await startOauthDeviceFlow();
        return;
      }
      setMessage(data.error ?? "OAuth belum siap");
      return;
    }
    router.replace("/chat");
  }

  async function importOauthFromCodex() {
    setMessage("");
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
    router.replace("/chat");
  }

  async function startOauthDeviceFlow() {
    const response = await fetch("/api/settings/auth", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "oauth-device-start" }),
    });
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error ?? "Gagal memulai OAuth device flow");
      return;
    }
    setOauthFlow({
      requestId: data.requestId,
      verificationUrl: data.verificationUrl,
      userCode: data.userCode,
      interval: Number(data.interval || 5),
      kind: "device",
    });
    setNextPollIn(Number(data.interval || 5));
  }

  async function startOauthCallbackFlow() {
    const response = await fetch("/api/settings/auth", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "oauth-callback-start" }),
    });
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error ?? "Gagal memulai OAuth callback flow");
      return;
    }
    setOauthFlow({
      requestId: data.requestId,
      verificationUrl: data.authorizeUrl,
      interval: 3,
      kind: "callback",
    });
    setNextPollIn(3);
    window.open(data.authorizeUrl, "_blank", "noopener,noreferrer");
  }

  async function checkOauthDeviceFlow() {
    if (!oauthFlow) return;
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
      setMessage(`Menunggu verifikasi... cek lagi ${oauthFlow.interval} detik.`);
      setNextPollIn(oauthFlow.interval);
      setOauthPolling(false);
      return;
    }
    if (!response.ok) {
      setMessage(data.error ?? "OAuth device flow gagal");
      setOauthPolling(false);
      return;
    }
    setOauthPolling(false);
    router.replace("/chat");
  }

  useEffect(() => {
    if (!oauthFlow) return;
    const intervalMs = Math.max(3, oauthFlow.interval) * 1000;
    const timer = window.setInterval(() => {
      if (!oauthPolling) void checkOauthDeviceFlow();
    }, intervalMs);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oauthFlow, oauthPolling]);

  useEffect(() => {
    if (!oauthFlow || nextPollIn === null) return;
    const timer = window.setInterval(() => {
      setNextPollIn((value) => {
        if (value === null) return null;
        return Math.max(0, value - 1);
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [oauthFlow, nextPollIn]);

  return (
    <main className="login-page">
      <section className="login-card">
        <h1>Sign in to FCode</h1>
        <p className="login-muted">Pilih login via ChatGPT OAuth atau API key.</p>

        <div className="login-mode-row">
          <button className={`pill ${mode === "oauth" ? "active" : ""}`} onClick={() => setMode("oauth")}>ChatGPT OAuth</button>
          <button className={`pill ${mode === "api-key" ? "active" : ""}`} onClick={() => setMode("api-key")}>API Key</button>
        </div>

        {mode === "oauth" ? (
          <div className="login-panel">
            <p className="login-muted">Saat klik OAuth, FCode cek token lokal dulu. Jika kosong, lanjut sesuai mode pilihan. Import dari Codex manual (opsional).</p>
            <div className="login-mode-row mt-3">
              <button className={`pill ${oauthMethod === "callback" ? "active" : ""}`} onClick={() => setOauthMethod("callback")}>Callback</button>
              <button className={`pill ${oauthMethod === "device" ? "active" : ""}`} onClick={() => setOauthMethod("device")}>Device</button>
            </div>
            <button className="primary-button mt-3" onClick={() => void loginOauth()}>Use OAuth session</button>
            <button className="secondary-button mt-2" onClick={() => void importOauthFromCodex()}>Import OAuth from Codex (Optional)</button>
            {oauthFlow ? (
              <div className="mt-3 space-y-2 text-sm">
                <p className="login-muted">{oauthFlow.kind === "callback" ? "Buka authorize URL:" : "1) Buka link ini:"}</p>
                <a className="block break-all text-sm underline" href={oauthFlow.verificationUrl} target="_blank" rel="noopener noreferrer">{oauthFlow.verificationUrl}</a>
                <button className="secondary-button mt-2" onClick={() => window.open(oauthFlow.verificationUrl, "_blank", "noopener,noreferrer")}>Open verification URL</button>
                {oauthFlow.kind === "device" ? (
                  <>
                    <p className="login-muted">2) Masukkan kode ini:</p>
                    <code>{oauthFlow.userCode}</code>
                    <button className="secondary-button mt-2" onClick={() => void navigator.clipboard.writeText(oauthFlow.userCode || "")}>Copy code</button>
                  </>
                ) : null}
                {nextPollIn !== null ? <p className="login-muted">Next check: {nextPollIn}s</p> : null}
                <button className="primary-button mt-2" onClick={() => void checkOauthDeviceFlow()}>{oauthPolling ? "Checking..." : "I already verified, check now"}</button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="login-panel">
            <label className="text-sm">API key</label>
            <input type="password" className="mt-2 w-full rounded-lg border bg-transparent p-2 text-sm" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-..." />
            <label className="mt-3 block text-sm">Base URL</label>
            <input className="mt-2 w-full rounded-lg border bg-transparent p-2 text-sm" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" />
            <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>Contoh custom: http://localhost:20128/v1</p>
            <button className="primary-button mt-3" onClick={() => void loginApiKey()} disabled={!apiKey.trim()}>Save and continue</button>
          </div>
        )}

        {message ? <p className="login-error">{message}</p> : null}
      </section>
    </main>
  );
}
