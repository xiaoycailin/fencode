"use client";

import { useEffect, useState } from "react";

type Worktree = { path: string; branch: string; head?: string; detached?: boolean; locked?: string };

export default function WorktreesPage() {
  const [rows, setRows] = useState<Worktree[]>([]);
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("main");
  const [error, setError] = useState("");

  async function load() {
    const data = await fetch("/api/git/worktrees").then((response) => response.json());
    setRows(data.data ?? []);
    setError(data.error ?? "");
  }

  useEffect(() => { void load(); }, []);

  async function add() {
    const response = await fetch("/api/git/worktree/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, branch }),
    });
    if (!response.ok) setError((await response.json()).error ?? "Failed to add worktree");
    setPath("");
    await load();
  }

  return (
    <section className="page-wrap">
      <div className="grid gap-4 md:grid-cols-[340px_minmax(0,1fr)]">
        <div className="page-card">
          <h1 className="text-lg font-semibold">Add worktree</h1>
          <input className="mt-4 w-full rounded-lg border bg-transparent p-2 text-sm" value={path} onChange={(event) => setPath(event.target.value)} placeholder="D:\\worktrees\\feature-x" />
          <input className="mt-2 w-full rounded-lg border bg-transparent p-2 text-sm" value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="branch" />
          <button className="primary-button mt-3" onClick={add}>Add worktree</button>
          {error ? <p className="mt-3 text-sm" style={{ color: "var(--error)" }}>{error}</p> : null}
        </div>
        <div className="page-card">
          <h2 className="text-lg font-semibold">Worktrees</h2>
          <div className="mt-4 space-y-2">
            {rows.map((row) => (
              <div key={row.path} className="panel-card flex items-center justify-between">
                <div>
                  <strong>{row.branch}</strong>
                  <p className="text-sm" style={{ color: "var(--muted)" }}>{row.path}</p>
                  <p className="text-xs" style={{ color: "var(--faint)" }}>{row.head?.slice(0, 8)}</p>
                </div>
                <button className="ghost-button" onClick={async () => { await fetch("/api/git/worktree/remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: row.path }) }); await load(); }}>Remove</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
