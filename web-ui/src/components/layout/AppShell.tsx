"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Bot, FolderGit2, GitBranch, Moon, Plus, Search, Settings, Sun, TerminalSquare, Trash2, Workflow } from "lucide-react";
import { useEffect, useState } from "react";
import type { Session } from "@/types/session";
import { useSessionStore } from "@/stores/sessionStore";

type VersionState = {
  packageName: string;
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  updateCommand: string;
  error?: string;
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [sessions, setSessions] = useState<Session[]>([]);
  const { currentSessionTitle, currentWorkspacePath } = useSessionStore();
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
  const [version, setVersion] = useState<VersionState | null>(null);
  const [updating, setUpdating] = useState(false);
  const [targetVersion, setTargetVersion] = useState("");
  const [baseVersion, setBaseVersion] = useState("");

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("fcode:theme");
    if (savedTheme === "light" || savedTheme === "dark") {
      setTheme(savedTheme);
      return;
    }
    setTheme("dark");
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    window.localStorage.setItem("fcode:theme", theme);
  }, [theme]);

  useEffect(() => {
    void fetch("/api/settings/auth", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        const detected = data.detected;
        if (!detected?.hasApiKey && !detected?.hasTokens) router.replace("/login");
      })
      .catch(() => router.replace("/login"));
  }, [router]);

  useEffect(() => {
    function refreshSessions() {
      void fetch("/api/sessions", { cache: "no-store" }).then((res) => res.json()).then((data) => setSessions(data.data ?? []));
    }
    refreshSessions();
    window.addEventListener("fcode:sessions-refresh", refreshSessions);
    return () => window.removeEventListener("fcode:sessions-refresh", refreshSessions);
  }, [pathname]);

  useEffect(() => {
    void fetch("/api/settings/version", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => setVersion(data))
      .catch(() => setVersion(null));
  }, []);

  useEffect(() => {
    if (!updating) return;
    const timer = window.setInterval(() => {
      void fetch("/api/settings/version", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: VersionState | null) => {
          if (!data) return;
          setVersion(data);
          const reachedTarget = !!targetVersion && data.currentVersion === targetVersion;
          const changedFromBase = !!baseVersion && data.currentVersion !== baseVersion && !data.hasUpdate;
          if (reachedTarget || changedFromBase) {
            window.location.reload();
          }
        })
        .catch(() => {
          // Server can be unavailable while fencode update restarts services.
        });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [baseVersion, targetVersion, updating]);

  async function createChat() {
    const preferredModel = typeof window !== "undefined" ? window.localStorage.getItem("fcode:last-model") ?? undefined : undefined;
    const preferredWorkspace = typeof window !== "undefined" ? window.localStorage.getItem("fcode:last-workspace") ?? undefined : undefined;
    const preferredPermission = typeof window !== "undefined" ? window.localStorage.getItem("fcode:last-permission") ?? undefined : undefined;
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "New chat",
        model: preferredModel,
        workspacePath: preferredWorkspace,
        permission: preferredPermission,
      }),
    });
    const data = await response.json();
    setSessions((current) => [data.session, ...current.filter((session) => session.id !== data.session.id)]);
    router.push(`/chat/${data.session.id}`);
  }

  async function deleteSession(session: Session) {
    await fetch(`/api/sessions/${session.id}`, { method: "DELETE" });
    const next = sessions.filter((item) => item.id !== session.id);
    setSessions(next);
    setDeleteTarget(null);
    if (pathname.includes(session.id)) {
      router.push(next[0] ? `/chat/${next[0].id}` : "/chat");
    }
    window.dispatchEvent(new Event("fcode:sessions-refresh"));
  }

  async function updateNow() {
    setUpdating(true);
    setBaseVersion(version?.currentVersion || "");
    setTargetVersion(version?.latestVersion || "");
    try {
      const response = await fetch("/api/settings/version", { method: "POST" });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        setUpdating(false);
        setTargetVersion("");
      }
    } catch {
      setUpdating(false);
      setTargetVersion("");
    }
  }

  const nav = [
    { href: "/workspace", label: "Workspace", icon: FolderGit2 },
    { href: "/git", label: "Git", icon: GitBranch },
    { href: "/worktrees", label: "Worktrees", icon: Workflow },
    { href: "/mcp", label: "MCP", icon: TerminalSquare },
  ];

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="FCode Sidebar">
        <div className="sidebar-header">
          <div className="brand-stack">
            <Link className="brand" href="/chat">
              <span className="brand-mark">F</span>
              <span className="hide-compact">FCode V2</span>
            </Link>
            <div className="hide-compact sidebar-version-block">
              <span className="sidebar-version-text">v{version?.currentVersion || "..."}</span>
              {version?.hasUpdate && version.latestVersion ? (
                <div className="sidebar-update-callout">
                  <span>New version available: v{version.latestVersion}</span>
                  <button type="button" className="sidebar-update-button" disabled={updating} onClick={() => void updateNow()}>
                    {updating ? <><span>Updating</span><span className="sidebar-update-dots"><i /><i /><i /></span></> : "Update now"}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
          <button className="icon-button" aria-label="New chat" onClick={createChat}><Plus size={16} /></button>
        </div>
        <div className="sidebar-body">
          <button className="nav-row" onClick={createChat}><Plus size={16} /><span className="hide-compact">New chat</span></button>
          <div className="search-box"><Search size={14} /><input placeholder="Search sessions..." suppressHydrationWarning /></div>
          <div className="section-label">Navigation</div>
          {nav.map((item) => {
            const Icon = item.icon;
            return (
              <Link key={item.href} className="nav-row" href={item.href}>
                <Icon size={16} /><span className="hide-compact">{item.label}</span>
              </Link>
            );
          })}
          <div className="section-label">Sessions</div>
          {sessions.map((session) => (
            <div key={session.id} className={`session-row-wrap ${pathname.includes(session.id) ? "active" : ""}`}>
              <Link href={`/chat/${session.id}`} className="session-row">
                <Bot size={15} />
                <span className="session-title hide-compact">{session.title}</span>
              </Link>
              <button
                className="session-delete-button"
                aria-label={`Delete ${session.title}`}
                onClick={() => setDeleteTarget(session)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <div className="sidebar-footer">
          <button className="nav-row" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            <span className="hide-compact">{theme === "dark" ? "Light mode" : "Dark mode"}</span>
          </button>
          <Link className="nav-row" href="/settings"><Settings size={16} /><span className="hide-compact">Settings</span></Link>
        </div>
      </aside>
      <section className="main-frame">
        <header className="topbar">
          <div>
            {currentSessionTitle ? (
              <div className="topbar-session">
                <span className="topbar-session-title">{currentSessionTitle}</span>
                {currentWorkspacePath ? <span className="topbar-session-path">{currentWorkspacePath}</span> : null}
              </div>
            ) : null}
          </div>
          <div className="pill">main · clean · 0 changed</div>
        </header>
        <div className="content-area">{children}</div>
      </section>
      {deleteTarget ? (
        <div className="confirm-overlay" role="presentation" onClick={() => setDeleteTarget(null)}>
          <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-session-title" onClick={(event) => event.stopPropagation()}>
            <div className="confirm-icon"><Trash2 size={16} /></div>
            <div>
              <h2 id="delete-session-title">Delete chat session?</h2>
              <p>This deletes this session and its chat history.</p>
            </div>
            <div className="confirm-actions">
              <button className="ghost-button" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button className="danger-button" onClick={() => void deleteSession(deleteTarget)}>Delete</button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
