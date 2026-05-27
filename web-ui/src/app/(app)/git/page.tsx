"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ChevronDown, CircleDot, FileCode2, Folder, FolderOpen, GitBranch, GitCommitHorizontal, RefreshCw } from "lucide-react";
import ReactDiffViewer from "react-diff-viewer-continued";

type GitStatus = {
  isRepo: boolean;
  root: string;
  branch?: string;
  changedFiles?: number;
  stagedFiles?: number;
  unstagedFiles?: number;
  untrackedFiles?: number;
  lastCommit?: string;
  error?: string;
  files?: Array<{ path: string; working_dir: string; index: string }>;
};

type WorkspaceOption = {
  id: string;
  label: string;
  path: string;
};

type FileNode = {
  id: string;
  name: string;
  path: string;
  kind: "folder" | "file";
  children?: FileNode[];
  file?: { path: string; working_dir: string; index: string };
};

export default function GitPage() {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [diff, setDiff] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [darkMode, setDarkMode] = useState(true);
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);

  const loadDiff = useCallback(async (path?: string | null, rootOverride?: string) => {
    const params = new URLSearchParams();
    const activeRoot = rootOverride ?? workspaceRoot;
    if (activeRoot) params.set("root", activeRoot);
    if (path) params.set("path", path);
    const query = params.size ? `?${params.toString()}` : "";
    const response = await fetch(`/api/git/diff${query}`, { cache: "no-store" });
    const data = await response.json();
    setDiff(data.diff ?? data.error ?? "");
  }, [workspaceRoot]);

  const refresh = useCallback(async (nextSelectedPath: string | null, rootOverride?: string) => {
    let root = rootOverride ?? workspaceRoot;
    setLoading(true);
    const query = root ? `?root=${encodeURIComponent(root)}` : "";
    let statusResponse = await fetch(`/api/git/status${query}`, { cache: "no-store" });
    let nextStatus: GitStatus = await statusResponse.json();
    if (root && !nextStatus.isRepo) {
      statusResponse = await fetch("/api/git/status", { cache: "no-store" });
      const fallbackStatus: GitStatus = await statusResponse.json();
      if (fallbackStatus.isRepo && fallbackStatus.root) {
        root = fallbackStatus.root;
        setWorkspaceRoot(root);
        setWorkspaces((prev) =>
          dedupeWorkspaces([
            ...prev,
            { id: "detected-root", label: `Detected · ${root.split(/[\\/]/).at(-1) || root}`, path: root },
          ]),
        );
        window.localStorage.setItem("fcode:last-workspace", root);
        nextStatus = fallbackStatus;
      }
    }
    setStatus(nextStatus);
    const nextFiles = nextStatus.files ?? [];
    const nextPath = nextSelectedPath && nextFiles.some((file) => file.path === nextSelectedPath)
      ? nextSelectedPath
      : nextFiles[0]?.path ?? null;
    setSelectedPath(nextPath);
    await loadDiff(nextPath, root);
    setLoading(false);
  }, [loadDiff, workspaceRoot]);

  useEffect(() => {
    const syncTheme = () => setDarkMode(document.documentElement.classList.contains("dark"));
    syncTheme();
    const preferred = window.localStorage.getItem("fcode:last-workspace") ?? "";
    setWorkspaceRoot(preferred);
    void fetch("/api/settings/workspaces", { cache: "no-store" })
      .then((response) => response.json())
      .then(async (data) => {
        const options = dedupeWorkspaces((data.data ?? []) as WorkspaceOption[]);
        setWorkspaces(options);
        if (preferred && options.some((item) => item.path === preferred)) return;
        for (const option of options) {
          const statusResponse = await fetch(`/api/git/status?root=${encodeURIComponent(option.path)}`, { cache: "no-store" });
          const info = (await statusResponse.json()) as GitStatus;
          if (info.isRepo) {
            setWorkspaceRoot(option.path);
            window.localStorage.setItem("fcode:last-workspace", option.path);
            return;
          }
        }
      });
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    void refresh(null);
  }, [refresh, workspaceRoot]);

  const files = status?.files ?? [];
  const selectedFile = files.find((file) => file.path === selectedPath);
  const tree = buildFileTree(files);

  return (
    <section className="page-wrap">
      <div className="git-page-head">
        <div>
          <p className="eyebrow">Repository</p>
          <h1>Git changes</h1>
        </div>
        <button className="ghost-button" onClick={() => void refresh(selectedPath)} disabled={loading}>
          <RefreshCw size={13} className={loading ? "spin-icon" : ""} />
          Refresh
        </button>
      </div>
      <div className="git-workspace-row">
        <span>Workspace</span>
        <div className="git-workspace-dropdown">
          <button
            className="git-workspace-trigger"
            type="button"
            onClick={() => setWorkspaceMenuOpen((open) => !open)}
          >
            <GitBranch size={13} />
            <span>{workspaceLabel(workspaceRoot, workspaces)}</span>
            <ChevronDown size={13} className={workspaceMenuOpen ? "open" : ""} />
          </button>
          {workspaceMenuOpen ? (
            <div className="git-workspace-menu">
              {workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  className={`git-workspace-option ${workspace.path === workspaceRoot ? "active" : ""}`}
                  type="button"
                  onClick={() => {
                    setWorkspaceRoot(workspace.path);
                    setWorkspaceMenuOpen(false);
                    window.localStorage.setItem("fcode:last-workspace", workspace.path);
                    void refresh(null, workspace.path);
                  }}
                >
                  <strong>{workspace.label}</strong>
                  <small>{workspace.path}</small>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="git-layout">
        <div className="git-sidebar">
          <div className="git-summary-card">
            <div className="git-summary-top">
              <span className="git-branch-icon"><GitBranch size={15} /></span>
              <div>
                <p className="git-muted">Branch</p>
                <strong>{status?.branch ?? "No repo"}</strong>
                {workspaceRoot ? <p className="git-root-path">{workspaceRoot}</p> : null}
              </div>
            </div>
            {!status?.isRepo ? (
              <p className="git-empty">{status?.error ?? "No Git repository detected"}</p>
            ) : (
              <>
                <div className="git-stats">
                  <Stat label="Changed" value={status.changedFiles ?? 0} tone="accent" />
                  <Stat label="Staged" value={status.stagedFiles ?? 0} tone="success" />
                  <Stat label="Unstaged" value={status.unstagedFiles ?? 0} tone="warning" />
                  <Stat label="Untracked" value={status.untrackedFiles ?? 0} tone="muted" />
                </div>
                <div className="git-last-commit">
                  <GitCommitHorizontal size={14} />
                  <span>{status.lastCommit || "No commit yet"}</span>
                </div>
              </>
            )}
          </div>

          <div className="git-file-list">
            <div className="git-section-title">Changed files</div>
            {files.length ? (
              <div className="git-tree">
                {tree.map((node) => (
                  <TreeRow
                    key={node.id}
                    node={node}
                    depth={0}
                    expandedFolders={expandedFolders}
                    setExpandedFolders={setExpandedFolders}
                    selectedPath={selectedPath}
                    onSelect={(filePath) => {
                      setSelectedPath(filePath);
                      void loadDiff(filePath, workspaceRoot);
                    }}
                  />
                ))}
              </div>
            ) : (
              <div className="git-empty-row">
                <CheckCircle2 size={14} />
                Working tree clean
              </div>
            )}
          </div>
        </div>

        <div className="git-diff-panel">
          <div className="git-diff-toolbar">
            <div>
              <p className="eyebrow">File preview</p>
              <h2>{selectedPath ?? "Workspace diff"}</h2>
            </div>
            <div className="git-diff-toolbar-actions">
              {selectedFile ? <StatusBadge index={selectedFile.index} working={selectedFile.working_dir} /> : null}
              <span className="git-diff-count">{diff ? `${diff.split("\n").length} lines` : "clean"}</span>
            </div>
          </div>
          <DiffView diff={diff} selectedPath={selectedPath} darkMode={darkMode} />
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "accent" | "success" | "warning" | "muted" }) {
  return (
    <div className={`git-stat git-stat-${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function StatusBadge({ index, working }: { index: string; working: string }) {
  const code = index || working || "?";
  const tone = code === "A" || code === "?" ? "add" : code === "D" ? "del" : "mod";
  return <span className={`git-status git-status-${tone}`}>{code}</span>;
}

function workspaceLabel(path: string, workspaces: WorkspaceOption[]) {
  const workspace = workspaces.find((item) => item.path === path);
  if (workspace) return workspace.label;
  return path.split(/[\\/]/).at(-1) || "Workspace";
}

function dedupeWorkspaces(items: WorkspaceOption[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.path.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function TreeRow({
  node,
  depth,
  expandedFolders,
  setExpandedFolders,
  selectedPath,
  onSelect,
}: {
  node: FileNode;
  depth: number;
  expandedFolders: Record<string, boolean>;
  setExpandedFolders: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const isFolder = node.kind === "folder";
  const isExpanded = Boolean(expandedFolders[node.path] ?? true);
  const indent = { paddingLeft: `${10 + depth * 14}px` };

  if (isFolder) {
    return (
      <>
        <button
          className="git-folder-row"
          style={indent}
          onClick={() => setExpandedFolders((prev) => ({ ...prev, [node.path]: !isExpanded }))}
        >
          <ChevronDown className={`git-folder-chevron ${isExpanded ? "open" : ""}`} size={13} />
          {isExpanded ? <FolderOpen size={14} /> : <Folder size={14} />}
          <span>{node.name}</span>
        </button>
        {isExpanded ? node.children?.map((child) => (
          <TreeRow
            key={child.id}
            node={child}
            depth={depth + 1}
            expandedFolders={expandedFolders}
            setExpandedFolders={setExpandedFolders}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        )) : null}
      </>
    );
  }

  return (
    <button
      className={`git-file-row ${node.path === selectedPath ? "active" : ""}`}
      style={indent}
      onClick={() => onSelect(node.path)}
    >
      <StatusBadge index={node.file?.index ?? ""} working={node.file?.working_dir ?? ""} />
      <FileCode2 size={14} />
      <span>{node.name}</span>
    </button>
  );
}

function DiffView({ diff, selectedPath, darkMode }: { diff: string; selectedPath: string | null; darkMode: boolean }) {
  if (!diff.trim()) {
    return (
      <div className="git-clean-state">
        <CircleDot size={18} />
        <span>{selectedPath ? "No diff preview for this file." : "No diff. Working tree clean."}</span>
      </div>
    );
  }

  const parsed = parseUnifiedDiff(diff);

  return (
    <div className="git-diff-library">
      <ReactDiffViewer
        oldValue={parsed.oldValue}
        newValue={parsed.newValue}
        splitView
        showDiffOnly
        useDarkTheme={darkMode}
        leftTitle={parsed.oldTitle}
        rightTitle={parsed.newTitle}
        summary={selectedPath ?? "Workspace diff"}
        disableWorker
        styles={diffViewerStyles}
      />
    </div>
  );
}

function parseUnifiedDiff(diff: string) {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let oldTitle = "Before";
  let newTitle = "After";

  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) {
      oldTitle = line.replace(/^---\s+/, "");
      continue;
    }
    if (line.startsWith("+++ ")) {
      newTitle = line.replace(/^\+\+\+\s+/, "");
      continue;
    }
    if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("@@")) continue;
    if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith("+")) {
      newLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith(" ")) {
      const value = line.slice(1);
      oldLines.push(value);
      newLines.push(value);
    }
  }

  return {
    oldTitle,
    newTitle,
    oldValue: oldLines.join("\n"),
    newValue: newLines.join("\n"),
  };
}

const diffViewerStyles = {
  variables: {
    dark: {
      diffViewerBackground: "var(--surface-2)",
      diffViewerColor: "var(--text)",
      addedBackground: "rgba(34, 197, 94, 0.14)",
      addedColor: "var(--text)",
      removedBackground: "rgba(239, 68, 68, 0.14)",
      removedColor: "var(--text)",
      wordAddedBackground: "rgba(34, 197, 94, 0.28)",
      wordRemovedBackground: "rgba(239, 68, 68, 0.28)",
      gutterBackground: "var(--surface-3)",
      gutterBackgroundDark: "var(--surface-3)",
      addedGutterBackground: "rgba(34, 197, 94, 0.18)",
      removedGutterBackground: "rgba(239, 68, 68, 0.18)",
      gutterColor: "var(--faint)",
      addedGutterColor: "var(--success)",
      removedGutterColor: "var(--error)",
      codeFoldBackground: "var(--surface-3)",
      codeFoldGutterBackground: "var(--surface-3)",
      codeFoldContentColor: "var(--muted)",
    },
    light: {
      diffViewerBackground: "var(--surface-2)",
      diffViewerColor: "var(--text)",
      addedBackground: "rgba(22, 163, 74, 0.12)",
      addedColor: "var(--text)",
      removedBackground: "rgba(220, 38, 38, 0.12)",
      removedColor: "var(--text)",
      wordAddedBackground: "rgba(22, 163, 74, 0.24)",
      wordRemovedBackground: "rgba(220, 38, 38, 0.24)",
      gutterBackground: "var(--surface-3)",
      addedGutterBackground: "rgba(22, 163, 74, 0.16)",
      removedGutterBackground: "rgba(220, 38, 38, 0.16)",
      gutterColor: "var(--faint)",
      addedGutterColor: "var(--success)",
      removedGutterColor: "var(--error)",
      codeFoldBackground: "var(--surface-3)",
      codeFoldGutterBackground: "var(--surface-3)",
      codeFoldContentColor: "var(--muted)",
    },
  },
  diffContainer: {
    borderRadius: 0,
    fontFamily: "var(--font-geist-mono), ui-monospace",
    fontSize: "12px",
  },
  contentText: {
    fontFamily: "var(--font-geist-mono), ui-monospace",
    lineHeight: "1.55",
  },
  lineNumber: {
    fontFamily: "var(--font-geist-mono), ui-monospace",
    minWidth: "46px",
  },
  marker: {
    fontWeight: 700,
  },
  summary: {
    borderBottom: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--muted)",
    fontSize: "12px",
  },
  titleBlock: {
    background: "var(--surface)",
    borderBottom: "1px solid var(--border)",
    color: "var(--muted)",
    fontSize: "12px",
  },
};

function buildFileTree(files: Array<{ path: string; working_dir: string; index: string }>): FileNode[] {
  const root: FileNode = { id: "root", name: "", path: "", kind: "folder", children: [] };

  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let current = root;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const fullPath = parts.slice(0, i + 1).join("/");
      const isLeaf = i === parts.length - 1;
      current.children ??= [];
      let child = current.children.find((entry) => entry.path === fullPath);
      if (!child) {
        child = {
          id: fullPath,
          name: part,
          path: fullPath,
          kind: isLeaf ? "file" : "folder",
          children: isLeaf ? undefined : [],
          file: isLeaf ? file : undefined,
        };
        current.children.push(child);
      } else if (isLeaf) {
        child.kind = "file";
        child.file = file;
      }
      current = child;
    }
  }

  return sortTree(root.children ?? []);
}

function sortTree(nodes: FileNode[]): FileNode[] {
  return [...nodes]
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((node) => node.kind === "folder" ? { ...node, children: sortTree(node.children ?? []) } : node);
}
