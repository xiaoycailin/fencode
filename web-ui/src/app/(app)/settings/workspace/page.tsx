"use client";

import { useEffect, useState } from "react";
import { FolderGit2, Trash2 } from "lucide-react";
import { SettingsLayout } from "@/components/settings/SettingsLayout";
import type { WorkspaceConfig } from "@/lib/db";

export default function SettingsWorkspacePage() {
  const [workspaces, setWorkspaces] = useState<WorkspaceConfig[]>([]);
  const [path, setPath] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);

  async function load() {
    const data = await fetch("/api/settings/workspaces").then((response) => response.json());
    setWorkspaces(data.data ?? []);
  }

  useEffect(() => { void load(); }, []);

  async function add() {
    if (!path.trim()) return;
    await fetch("/api/settings/workspaces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
    setPath("");
    await load();
  }

  return (
    <SettingsLayout title="Workspace">
      <div className="workspace-settings">
        <div className="workspace-add-row">
        <input className="config-input" value={path} onChange={(event) => setPath(event.target.value)} placeholder="D:\\project\\path" />
        <button className="primary-button" onClick={add}>Add</button>
      </div>
        <p className="workspace-note">Synced with active FenCode config projects.</p>
      <div className="workspace-list">
        {workspaces.map((workspace) => (
          <div key={workspace.id} className="workspace-row">
            <div className="workspace-row-icon"><FolderGit2 size={15} /></div>
            <div className="workspace-row-main"><strong>{workspace.label}</strong><p>{workspace.path}</p></div>
            {deleting === workspace.id ? (
              <div className="workspace-row-actions">
                <button className="ghost-button" onClick={() => setDeleting(null)}>Cancel</button>
                <button className="danger-button" onClick={async () => { await fetch(`/api/settings/workspaces/${workspace.id}`, { method: "DELETE" }); setDeleting(null); await load(); }}>Delete</button>
              </div>
            ) : (
              <button className="workspace-delete" aria-label={`Delete ${workspace.label}`} onClick={() => setDeleting(workspace.id)}><Trash2 size={14} /></button>
            )}
          </div>
        ))}
      </div>
      </div>
    </SettingsLayout>
  );
}
