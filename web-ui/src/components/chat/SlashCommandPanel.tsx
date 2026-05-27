"use client";

import { X } from "lucide-react";
import type { Session } from "@/types/session";

type PanelKind = "status" | "memories" | "personality";

type Props = {
  kind: PanelKind;
  session: Session;
  planModeEnabled: boolean;
  onClose: () => void;
};

const MEMORY_ITEMS = [
  { label: "Workspace memory", value: "Current workspace context and recent run state." },
  { label: "Session memory", value: "Messages, activity, files, and command history for this chat." },
  { label: "User preference", value: "Compact Codex-style UI, realtime activity, dark/light support." },
];

const PERSONALITY_ITEMS = [
  { label: "Assistant", value: "Fennai" },
  { label: "Tone", value: "Short, clear, practical" },
  { label: "Mode", value: "Production UI engineer" },
];

export function SlashCommandPanel({ kind, session, planModeEnabled, onClose }: Props) {
  if (kind === "status") {
    return (
      <section className="slash-panel" aria-label="Status command panel">
        <PanelHeader title="/status" subtitle="Current session context" onClose={onClose} />
        <div className="slash-panel-grid">
          <Metric label="Session" value={session.id} />
          <Metric label="Model" value={session.model} />
          <Metric label="Permission" value={session.permission} />
          <Metric label="Plan mode" value={planModeEnabled ? "On" : "Off"} />
          <Metric label="Context" value={`${session.contextUsagePct ?? 0}%`} />
          <Metric label="Window" value={session.contextWindow ? session.contextWindow.toLocaleString() : "-"} />
        </div>
        <div className="slash-panel-section">
          <div className="slash-panel-kicker">Workspace</div>
          <div className="slash-panel-path">{session.workspacePath}</div>
        </div>
        {session.compactedAt ? (
          <div className="slash-panel-section">
            <div className="slash-panel-kicker">Last compact</div>
            <div className="slash-panel-path">{session.compactedAt}</div>
          </div>
        ) : null}
      </section>
    );
  }

  if (kind === "memories") {
    return (
      <section className="slash-panel" aria-label="Memories command panel">
        <PanelHeader title="/memories" subtitle="Context sources available to this UI" onClose={onClose} />
        <div className="slash-panel-list">
          {MEMORY_ITEMS.map((item) => (
            <PanelRow key={item.label} label={item.label} value={item.value} />
          ))}
        </div>
        {session.compactSummary ? <p className="slash-panel-note">Context summary active for this thread.</p> : null}
        <p className="slash-panel-note">Backend memory browser can plug into this panel later.</p>
      </section>
    );
  }

  return (
    <section className="slash-panel" aria-label="Personality command panel">
      <PanelHeader title="/personality" subtitle="Active assistant behavior" onClose={onClose} />
      <div className="slash-panel-list">
        {PERSONALITY_ITEMS.map((item) => (
          <PanelRow key={item.label} label={item.label} value={item.value} />
        ))}
      </div>
      <p className="slash-panel-note">Personas from settings can replace this local summary.</p>
    </section>
  );
}

function PanelHeader({ title, subtitle, onClose }: { title: string; subtitle: string; onClose: () => void }) {
  return (
    <div className="slash-panel-header">
      <div>
        <div className="slash-panel-title">{title}</div>
        <div className="slash-panel-subtitle">{subtitle}</div>
      </div>
      <button className="slash-panel-close" type="button" aria-label="Close command panel" onClick={onClose}>
        <X size={13} />
      </button>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="slash-panel-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PanelRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="slash-panel-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
