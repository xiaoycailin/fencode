"use client";

import { useEffect, useState } from "react";
import { SettingsLayout } from "@/components/settings/SettingsLayout";
import { SettingsSelect } from "@/components/settings/SettingsSelect";

type ImageGenSettings = { selectedModel: string; models: string[] };

export default function SettingsImageGenPage() {
  const [settings, setSettings] = useState<ImageGenSettings>({ selectedModel: "", models: [] });
  const [newModel, setNewModel] = useState("");

  async function load() {
    const data = await fetch("/api/settings/imagegen").then((response) => response.json());
    setSettings(data);
  }

  useEffect(() => { void load(); }, []);

  async function patch(body: Record<string, string>) {
    const data = await fetch("/api/settings/imagegen", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((response) => response.json());
    setSettings(data);
  }

  return (
    <SettingsLayout title="Image Gen">
      <div className="skills-settings">
        <div className="panel-card">
          <label className="config-field">
            <span>Default image model</span>
            <SettingsSelect
              value={settings.selectedModel}
              items={settings.models.map((model) => ({ value: model, label: model }))}
              onChange={(value) => void patch({ selectedModel: value })}
              placeholder="Image model"
            />
          </label>
        </div>
        <div className="panel-card">
          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
            <input className="config-input" value={newModel} onChange={(event) => setNewModel(event.target.value)} placeholder="cx/gpt-5.5-image" />
            <button className="primary-button" onClick={async () => { if (!newModel.trim()) return; await patch({ addModel: newModel.trim() }); setNewModel(""); }}>Add model</button>
          </div>
        </div>
        <div className="space-y-2">
          {settings.models.map((model) => (
            <div key={model} className="panel-card flex items-center justify-between gap-3">
              <div>
                <strong>{model}</strong>
                {model === settings.selectedModel ? <p className="text-sm" style={{ color: "var(--muted)" }}>Selected default</p> : null}
              </div>
              <div className="flex gap-2">
                <button className="ghost-button" onClick={() => void patch({ selectedModel: model })}>Use</button>
                <button className="ghost-button" onClick={() => void patch({ removeModel: model })}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </SettingsLayout>
  );
}
