"use client";

import { useEffect, useState } from "react";

type TreeNode = { id: string; name: string; path: string; type: "file" | "directory"; children?: TreeNode[] };

function flatten(nodes: TreeNode[], depth = 0): Array<TreeNode & { depth: number }> {
  return nodes.flatMap((node) => [
    { ...node, depth },
    ...(node.children ? flatten(node.children, depth + 1) : []),
  ]);
}

export default function WorkspacePage() {
  const [root, setRoot] = useState("");
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [selected, setSelected] = useState("README.md");
  const [content, setContent] = useState("");

  useEffect(() => {
    void fetch("/api/workspace/tree").then((response) => response.json()).then((data) => {
      setRoot(data.root);
      setTree(data.data ?? []);
    });
  }, []);

  useEffect(() => {
    if (!selected) return;
    void fetch(`/api/workspace/file?path=${encodeURIComponent(selected)}&root=${encodeURIComponent(root)}`).then((response) => response.json()).then((data) => setContent(data.content ?? data.error ?? ""));
  }, [root, selected]);

  return (
    <section className="page-wrap">
      <div className="grid gap-4 md:grid-cols-[300px_minmax(0,1fr)]">
        <div className="page-card">
          <h1 className="text-lg font-semibold">Workspace tree</h1>
          <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>{root}</p>
          <div className="mt-4 space-y-1">
            {flatten(tree).map((node) => (
              <button
                key={node.id}
                className="nav-row"
                style={{ paddingLeft: `${10 + node.depth * 14}px` }}
                onClick={() => node.type === "file" && setSelected(node.path)}
              >
                <span>{node.type === "directory" ? "📁" : "📄"}</span>
                <span className="session-title">{node.path}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="page-card">
          <h2 className="text-lg font-semibold">{selected || "Select file"}</h2>
          <pre className="mt-4 overflow-auto rounded-xl border p-4 text-sm" style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}>{content || "No content"}</pre>
        </div>
      </div>
    </section>
  );
}
