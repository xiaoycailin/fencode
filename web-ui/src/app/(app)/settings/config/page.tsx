"use client";

import { Check, ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { SettingsLayout } from "@/components/settings/SettingsLayout";

type ConfigState = {
  path: string;
  exists: boolean;
  raw: string;
  modelProvider: string;
  model: string;
  personality: string;
  reasoningEffort: string;
  instructions: string;
  memories: boolean;
  allowGlobalScan: boolean;
  provider: { id: string; name: string; baseUrl: string; wireApi: string };
  engineServerUrl: string;
  subagentModel: string;
};

type SaveResponse = {
  config: ConfigState;
  hotReloaded: boolean;
  hotReloadError: string | null;
};

type DetectedAuth = {
  mode: "api-key" | "oauth" | null;
};

type VersionState = {
  packageName: string;
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  updateCommand: string;
  error?: string;
};

const emptyConfig: ConfigState = {
  path: "",
  exists: false,
  raw: "",
  modelProvider: "9router",
  model: "gpt-5.5",
  personality: "pragmatic",
  reasoningEffort: "medium",
  instructions: "",
  memories: true,
  allowGlobalScan: false,
  provider: { id: "9router", name: "9Router", baseUrl: "http://127.0.0.1:20128/v1", wireApi: "responses" },
  engineServerUrl: "http://127.0.0.1:32188",
  subagentModel: "",
};

const personalities = [
  { value: "friendly", label: "Friendly", description: "Warm, collaborative, and helpful" },
  { value: "pragmatic", label: "Pragmatic", description: "Concise, task-focused, and direct" },
  { value: "creative", label: "Creative", description: "Exploratory, broad, and idea-forward" },
];

const efforts = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

export default function SettingsConfigPage() {
  const [config, setConfig] = useState<ConfigState>(emptyConfig);
  const [authMode, setAuthMode] = useState<"api-key" | "oauth" | null>(null);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [personalityOpen, setPersonalityOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [version, setVersion] = useState<VersionState | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateStatus, setUpdateStatus] = useState("");

  async function load() {
    const [configResponse, authResponse, versionResponse] = await Promise.all([
      fetch("/api/settings/config"),
      fetch("/api/settings/auth"),
      fetch("/api/settings/version"),
    ]);
    const data = (await configResponse.json()) as { config: ConfigState };
    const authData = (await authResponse.json()) as { detected?: DetectedAuth };
    const versionData = (await versionResponse.json()) as VersionState;
    setConfig(data.config);
    setAuthMode(authData.detected?.mode ?? null);
    setVersion(versionData);
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (authMode !== "oauth") return;
    setConfig((prev) => ({
      ...prev,
      provider: {
        ...prev.provider,
        baseUrl: "https://api.openai.com/v1",
      },
    }));
  }, [authMode]);

  async function saveStructured(nextConfig?: ConfigState) {
    const payload = nextConfig ?? config;
    setSaving(true);
    setStatus("");
    const response = await fetch("/api/settings/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "structured", ...payload }),
    });
    const data = (await response.json()) as SaveResponse;
    setConfig(data.config);
    setSaving(false);
    setStatus("Saved to standalone JSON config.");
  }

  async function saveRaw() {
    setSaving(true);
    setStatus("");
    const response = await fetch("/api/settings/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "raw", raw: config.raw }),
    });
    const data = (await response.json()) as SaveResponse;
    setConfig(data.config);
    setSaving(false);
    setStatus("Raw JSON saved.");
  }

  async function updateNow() {
    setUpdating(true);
    setUpdateStatus("");
    const response = await fetch("/api/settings/version", { method: "POST" });
    const data = (await response.json()) as { ok: boolean; output?: string };
    if (!response.ok || !data.ok) {
      setUpdateStatus("Update failed. Check terminal permission/npm login.");
      setUpdating(false);
      return;
    }
    setUpdateStatus("Updated package. Restart with: fencode restart");
    setUpdating(false);
    await load();
  }

  const currentPersonality = personalities.find((item) => item.value === config.personality) ?? personalities[1];
  const currentEffort = efforts.find((item) => item.value === config.reasoningEffort) ?? efforts[2];

  return (
    <SettingsLayout title="Config">
      <div className="config-settings">
        <section>
          <h2>FenCode Runtime</h2>
          <div className="config-version-card">
            <div className="config-version-head">
              <strong>{version?.packageName || "@aiden2209/fencode"}</strong>
              <span className="config-version-now">v{version?.currentVersion || "0.0.0"}</span>
            </div>
            {version?.hasUpdate && version.latestVersion ? (
              <p className="config-version-update">New version available: v{version.latestVersion}</p>
            ) : (
              <p className="config-version-ok">{version?.error ? "Update check failed (offline/login)." : "You are on latest version."}</p>
            )}
            <div className="config-version-actions">
              {version?.hasUpdate ? (
                <button disabled={updating} className="primary-button" onClick={() => void updateNow()}>
                  {updating ? "Updating..." : "Update now"}
                </button>
              ) : null}
              <code>{version?.updateCommand || "npm i -g @aiden2209/fencode@latest"}</code>
            </div>
            {updateStatus ? <small>{updateStatus}</small> : null}
          </div>
        </section>

        <section>
          <h2>Personalization</h2>
          <div className="config-row-card">
            <div>
              <strong>Personality</strong>
              <p>Choose default tone for FCode responses</p>
            </div>
            <div className="config-select">
              <button type="button" className="config-select-trigger" onClick={() => setPersonalityOpen((value) => !value)}>
                <span>{currentPersonality.label}</span>
                <ChevronDown size={16} />
              </button>
              {personalityOpen ? (
                <div className="config-select-menu">
                  {personalities.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className="config-select-item"
                      onClick={() => {
                        setConfig((prev) => ({ ...prev, personality: item.value }));
                        setPersonalityOpen(false);
                      }}
                    >
                      <span>
                        <b>{item.label}</b>
                        <small>{item.description}</small>
                      </span>
                      {item.value === config.personality ? <Check size={16} /> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </section>

        <section>
          <div className="config-section-head">
            <div>
              <h3>Custom instructions</h3>
              <p>Give FCode extra instructions and context for this machine.</p>
            </div>
            <button disabled={saving} className="config-save-button" onClick={() => void saveStructured()}>{saving ? "Saving..." : "Save"}</button>
          </div>
          <textarea
            className="config-instructions"
            value={config.instructions}
            onChange={(event) => setConfig((prev) => ({ ...prev, instructions: event.target.value }))}
            spellCheck={false}
          />
        </section>

        <section>
          <h3>Memory (experimental)</h3>
          <p className="config-muted">Configure how FCode collects, retains, and consolidates memories.</p>
          <div className="config-list-card">
            <SettingToggle
              title="Enable memories"
              description="Generate new memories from chats and bring them into new chats"
              checked={config.memories}
              onChange={(checked) => {
                const next = { ...config, memories: checked };
                setConfig(next);
                void saveStructured(next);
              }}
            />
            <SettingToggle
              title="Allow global scan"
              description="Allow read-only scan/read of absolute paths outside the active workspace"
              checked={config.allowGlobalScan}
              onChange={(checked) => {
                const next = { ...config, allowGlobalScan: checked };
                setConfig(next);
                void saveStructured(next);
              }}
            />
            <SettingToggle title="Skip tool-assisted chats" description="Do not generate memories from chats that used MCP tools or web search" checked={false} disabled />
            <div className="config-list-row">
              <div>
                <strong>Config file</strong>
                <p>{config.path || "~/.fencode-dev/config.json"}</p>
              </div>
              <button className="ghost-button" onClick={() => void load()}>Reload</button>
            </div>
          </div>
        </section>

        <section>
          <h3>Runtime</h3>
          <p className="config-muted">Model and provider values written to config.json.</p>
          <div className="config-grid">
            <Field label="Model provider" value={config.modelProvider} onChange={(value) => setConfig((prev) => ({ ...prev, modelProvider: value }))} />
            <Field label="Model" value={config.model} onChange={(value) => setConfig((prev) => ({ ...prev, model: value }))} />
            <Field label="Provider id" value={config.provider.id} onChange={(value) => setConfig((prev) => ({ ...prev, provider: { ...prev.provider, id: value } }))} />
            <Field label="Provider name" value={config.provider.name} onChange={(value) => setConfig((prev) => ({ ...prev, provider: { ...prev.provider, name: value } }))} />
            <Field
              label="Base URL"
              value={config.provider.baseUrl}
              disabled={authMode === "oauth"}
              hint={authMode === "oauth" ? "Locked by OAuth mode" : undefined}
              onChange={(value) => setConfig((prev) => ({ ...prev, provider: { ...prev.provider, baseUrl: value } }))}
            />
            <Field
              label="Wire API"
              value={config.provider.wireApi}
              disabled={authMode === "oauth"}
              hint={authMode === "oauth" ? "Locked by OAuth mode" : undefined}
              onChange={(value) => setConfig((prev) => ({ ...prev, provider: { ...prev.provider, wireApi: value } }))}
            />
            <Field label="Engine server URL" value={config.engineServerUrl} onChange={(value) => setConfig((prev) => ({ ...prev, engineServerUrl: value }))} />
            <Field label="Subagent model" value={config.subagentModel} onChange={(value) => setConfig((prev) => ({ ...prev, subagentModel: value }))} />
            <div className="config-field">
              <span>Reasoning effort</span>
              <div className="config-select config-select-inline">
                <button type="button" className="config-input config-select-trigger" onClick={() => setEffortOpen((value) => !value)}>
                  <span>{currentEffort.label}</span>
                  <ChevronDown size={15} />
                </button>
                {effortOpen ? (
                  <div className="config-select-menu">
                    {efforts.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        className="config-select-item"
                        onClick={() => {
                          setConfig((prev) => ({ ...prev, reasoningEffort: item.value }));
                          setEffortOpen(false);
                        }}
                      >
                        <span><b>{item.label}</b></span>
                        {item.value === config.reasoningEffort ? <Check size={16} /> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </section>

        <details className="config-advanced">
          <summary>Raw JSON (advanced)</summary>
          <textarea className="config-raw" value={config.raw} onChange={(event) => setConfig((prev) => ({ ...prev, raw: event.target.value }))} spellCheck={false} />
          <button disabled={saving} className="ghost-button" onClick={() => void saveRaw()}>Save raw JSON</button>
        </details>

        <div className="config-actions">
          <span>{status}</span>
          <button disabled={saving} className="primary-button" onClick={() => void saveStructured()}>{saving ? "Saving..." : "Save + Reload"}</button>
        </div>
      </div>
    </SettingsLayout>
  );
}

function Field({
  label,
  value,
  disabled,
  hint,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  hint?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="config-field">
      <span>{label}</span>
      <input className="config-input" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function SettingToggle({
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
}) {
  return (
    <label className={`config-list-row ${disabled ? "disabled" : ""}`}>
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange?.(event.target.checked)} />
      <span className="config-switch" aria-hidden="true" />
    </label>
  );
}
