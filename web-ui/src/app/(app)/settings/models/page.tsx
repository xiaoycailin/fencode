"use client";

import { Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { SettingsLayout } from "@/components/settings/SettingsLayout";
import type { ModelConfig } from "@/lib/db";

type ModelForm = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  contextWindow: string;
  inputModalities: string;
};

const defaultContextWindow = 272000;

const emptyForm: ModelForm = {
  id: "",
  name: "",
  baseUrl: "",
  apiKey: "",
  contextWindow: `${defaultContextWindow}`,
  inputModalities: "text",
};

export default function SettingsModelsPage() {
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ModelForm>(emptyForm);
  const [busy, setBusy] = useState(false);

  async function load() {
    const data = await fetch("/api/settings/models").then((response) => response.json());
    setModels(data.data ?? []);
  }

  useEffect(() => {
    void load();
  }, []);

  const editingModel = useMemo(() => models.find((model) => model.id === editingId) ?? null, [models, editingId]);

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setOpen(true);
  }

  function openEdit(model: ModelConfig) {
    setEditingId(model.id);
    setForm({
      id: model.id,
      name: model.name,
      baseUrl: model.baseUrl ?? "",
      apiKey: "",
      contextWindow: `${model.contextWindow || defaultContextWindow}`,
      inputModalities: (model.inputModalities ?? ["text"]).join(", "),
    });
    setOpen(true);
  }

  function closeModal() {
    if (busy) return;
    setOpen(false);
    setEditingId(null);
    setForm(emptyForm);
  }

  async function submit() {
    const id = form.id.trim();
    const name = form.name.trim();
    if (!id || !name) return;
    const contextWindow = Number(form.contextWindow) || defaultContextWindow;
    const inputModalities = form.inputModalities
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    setBusy(true);
    await fetch("/api/settings/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        name,
        baseUrl: form.baseUrl.trim() || undefined,
        apiKey: form.apiKey.trim() || undefined,
        contextWindow,
        inputModalities: inputModalities.length ? inputModalities : ["text"],
      }),
    });
    setBusy(false);
    closeModal();
    await load();
  }

  async function remove(id: string) {
    await fetch(`/api/settings/models/${encodeURIComponent(id)}`, { method: "DELETE" });
    await load();
  }

  return (
    <SettingsLayout title="Models">
      <div className="config-settings">
        <section>
          <div className="config-section-head">
            <div>
              <h3>Configured models</h3>
              <p>Model id, context window, base URL, and input modalities.</p>
            </div>
            <button className="config-save-button" onClick={openCreate}>
              <Plus size={14} />
              Add model
            </button>
          </div>
          <div className="config-list-card">
            {models.map((model) => (
              <div className="config-list-row" key={model.id}>
                <div>
                  <strong>{model.name}</strong>
                  <p>{model.id}</p>
                  <p>
                    {(model.contextWindow || defaultContextWindow).toLocaleString()} ctx
                    {" · "}
                    {(model.inputModalities ?? ["text"]).join(", ")}
                  </p>
                </div>
                <div style={{ display: "inline-flex", gap: 8 }}>
                  <button className="ghost-button" onClick={() => openEdit(model)}>
                    <Pencil size={13} />
                    Edit
                  </button>
                  <button className="ghost-button" onClick={() => void remove(model.id)}>
                    <Trash2 size={13} />
                    Delete
                  </button>
                </div>
              </div>
            ))}
            {!models.length ? <div className="config-list-row"><p>No models configured.</p></div> : null}
          </div>
        </section>
      </div>

      {open ? (
        <div className="confirm-overlay" onClick={closeModal}>
          <div className="confirm-dialog models-modal" onClick={(event) => event.stopPropagation()}>
            <div className="models-modal-head">
              <h2>{editingModel ? "Edit model" : "Add model"}</h2>
              <button className="ghost-button" onClick={closeModal}><X size={14} /></button>
            </div>
            <div className="models-modal-grid">
              <label className="config-field">
                <span>Model id</span>
                <input className="config-input" value={form.id} onChange={(event) => setForm((prev) => ({ ...prev, id: event.target.value }))} placeholder="gpt-5.5" />
              </label>
              <label className="config-field">
                <span>Model name</span>
                <input className="config-input" value={form.name} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} placeholder="GPT-5.5" />
              </label>
              <label className="config-field">
                <span>Context window</span>
                <input className="config-input" type="number" min={1024} value={form.contextWindow} onChange={(event) => setForm((prev) => ({ ...prev, contextWindow: event.target.value }))} placeholder={`${defaultContextWindow}`} />
              </label>
              <label className="config-field">
                <span>Input modalities</span>
                <input className="config-input" value={form.inputModalities} onChange={(event) => setForm((prev) => ({ ...prev, inputModalities: event.target.value }))} placeholder="text, image" />
              </label>
              <label className="config-field">
                <span>Base URL</span>
                <input className="config-input" value={form.baseUrl} onChange={(event) => setForm((prev) => ({ ...prev, baseUrl: event.target.value }))} placeholder="http://localhost:20128/v1" />
              </label>
              <label className="config-field">
                <span>API key (optional)</span>
                <input className="config-input" value={form.apiKey} onChange={(event) => setForm((prev) => ({ ...prev, apiKey: event.target.value }))} placeholder="sk-..." />
              </label>
            </div>
            <div className="confirm-actions">
              <button className="ghost-button" onClick={closeModal}>Cancel</button>
              <button className="primary-button" disabled={busy} onClick={() => void submit()}>{busy ? "Saving..." : "Save model"}</button>
            </div>
          </div>
        </div>
      ) : null}
    </SettingsLayout>
  );
}

