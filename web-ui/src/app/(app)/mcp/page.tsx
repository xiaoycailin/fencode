"use client";

import { useEffect, useState } from "react";

type McpServer = { id: string; name: string; transport: "stdio" | "sse"; command?: string; url?: string; status: string };

export default function McpPage() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");

  async function load() {
    const data = await fetch("/api/mcp/servers").then((response) => response.json());
    setServers(data.data ?? []);
  }

  useEffect(() => {
    void load();
  }, []);

  async function add() {
    if (!name.trim()) return;
    await fetch("/api/mcp/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, transport: "stdio", command }),
    });
    setName("");
    setCommand("");
    await load();
  }

  return (
    <section className="page-wrap">
      <div className="grid gap-4 md:grid-cols-[360px_minmax(0,1fr)]">
        <div className="page-card">
          <h1 className="text-lg font-semibold">Add MCP server</h1>
          <input className="mt-4 w-full rounded-lg border bg-transparent p-2 text-sm" placeholder="Name" value={name} onChange={(event) => setName(event.target.value)} />
          <input className="mt-2 w-full rounded-lg border bg-transparent p-2 text-sm" placeholder="Command" value={command} onChange={(event) => setCommand(event.target.value)} />
          <button className="primary-button mt-3" onClick={add}>Add server</button>
        </div>
        <div className="page-card">
          <h2 className="text-lg font-semibold">Servers</h2>
          <div className="mt-4 space-y-2">
            {servers.map((server) => (
              <div key={server.id} className="panel-card flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <strong>{server.name}</strong>
                  <p className="text-sm" style={{ color: "var(--muted)" }}>{server.transport} · {server.status}</p>
                  <code className="block truncate text-xs">{server.command || server.url}</code>
                </div>
                <button className="ghost-button" onClick={async () => { await fetch(`/api/mcp/servers/${server.id}`, { method: "DELETE" }); await load(); }}>Delete</button>
              </div>
            ))}
            {!servers.length ? <p className="text-sm" style={{ color: "var(--muted)" }}>No MCP servers configured.</p> : null}
          </div>
        </div>
      </div>
    </section>
  );
}
