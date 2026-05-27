"use client";

import { ChevronDown, FileDiff, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AgentEvent } from "@/types/events";

type EditedFile = {
  path: string;
  additions: number;
  deletions: number;
  lines: DiffLine[];
  language: string;
};

type DiffLine = {
  kind: "add" | "remove" | "context";
  lineNo?: number;
  sign: "+" | "-" | " ";
  text: string;
};

export function EditedFilesSummary({ events }: { events: AgentEvent[] }) {
  const files = useMemo(
    () =>
      events
        .filter((event) => event.type === "file.edit")
        .map((event) => {
          const payload = event.payload as { path?: string; diff?: string; additions?: number; deletions?: number };
          const path = String(payload.path ?? "unknown");
          return {
            path,
            additions: Number(payload.additions ?? 0),
            deletions: Number(payload.deletions ?? 0),
            lines: parseUnifiedDiff(String(payload.diff ?? "")),
            language: languageFromPath(path),
          };
        })
        .filter((file) => file.lines.length),
    [events],
  );

  if (!files.length) return null;

  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);

  return (
    <details className="edited-files-summary">
      <summary className="edited-files-head">
        <span className="edited-files-title">
          <span className="edited-files-icon"><FileDiff size={16} /></span>
          <span>
            <strong>Edited {files.length} {files.length === 1 ? "file" : "files"}</strong>
            <span className="edited-files-total">
              <span className="diff-plus">+{additions}</span>
              {" "}<span className="diff-minus">-{deletions}</span>
            </span>
          </span>
        </span>
        <span className="edited-files-actions">
          <button type="button" className="edited-files-link" disabled onClick={(event) => event.stopPropagation()}>
            Undo <RotateCcw size={12} />
          </button>
          <button type="button" className="ghost-button" onClick={(event) => event.stopPropagation()}>Review</button>
          <ChevronDown className="edited-files-chevron" size={14} />
        </span>
      </summary>
      <div className="edited-files-body">
        {files.map((file, index) => (
          <EditedFileBlock key={`${file.path}-${index}`} file={file} />
        ))}
      </div>
    </details>
  );
}

function EditedFileBlock({ file }: { file: EditedFile }) {
  const [highlighted, setHighlighted] = useState<string[]>([]);
  const [isDark, setIsDark] = useState(true);
  useEffect(() => {
    const refresh = () => setIsDark(document.documentElement.classList.contains("dark"));
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const lines = file.lines.map((line) => line.text || " ");
    void import("shiki")
      .then(({ codeToHtml }) => Promise.all(lines.map((line) =>
        codeToHtml(line, {
          lang: file.language,
          theme: isDark ? "github-dark" : "github-light",
        }),
      )))
      .then((htmlLines) => {
        if (cancelled) return;
        setHighlighted(htmlLines.map(extractCodeInnerHtml));
      })
      .catch(() => {
        if (!cancelled) setHighlighted([]);
      });
    return () => {
      cancelled = true;
    };
  }, [file.language, file.lines, isDark]);

  return (
    <details className="edited-file-block">
      <summary className="edited-file-row">
        <span className="edited-file-path">{file.path}</span>
        <span className="edited-file-stat">
          <span className="diff-plus">+{file.additions}</span>
          {" "}<span className="diff-minus">-{file.deletions}</span>
          <ChevronDown className="edited-file-chevron" size={13} />
        </span>
      </summary>
      <div className="edited-diff-code" role="table" aria-label={`Diff for ${file.path}`}>
        {file.lines.map((line, index) => (
          <div key={`${line.kind}-${index}-${line.lineNo ?? ""}`} className={`edited-diff-line ${line.kind}`} role="row">
            <span className={`edited-diff-sign ${line.kind}`}>{line.sign}</span>
            <span className="edited-diff-num">{line.lineNo ?? ""}</span>
            <code
              dangerouslySetInnerHTML={{
                __html: highlighted[index] ?? escapeHtml(line.text || " "),
              }}
            />
          </div>
        ))}
      </div>
    </details>
  );
}

function parseUnifiedDiff(diff: string): DiffLine[] {
  const output: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const rawLine of diff.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith("diff --git") || rawLine.startsWith("index ") || rawLine.startsWith("--- ") || rawLine.startsWith("+++ ")) continue;
    const hunk = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (rawLine.startsWith("+")) {
      output.push({ kind: "add", lineNo: newLine, sign: "+", text: rawLine.slice(1) });
      newLine += 1;
      continue;
    }
    if (rawLine.startsWith("-")) {
      output.push({ kind: "remove", lineNo: oldLine, sign: "-", text: rawLine.slice(1) });
      oldLine += 1;
      continue;
    }
    oldLine += 1;
    newLine += 1;
  }

  return output;
}

function languageFromPath(path: string) {
  const ext = path.toLowerCase().split(".").pop() || "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    css: "css",
    html: "html",
    md: "markdown",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    c: "c",
    cpp: "cpp",
    sh: "bash",
    ps1: "powershell",
    yml: "yaml",
    yaml: "yaml",
  };
  return map[ext] ?? "text";
}

function extractCodeInnerHtml(shikiHtml: string) {
  const matched = shikiHtml.match(/<code[^>]*>([\s\S]*?)<\/code>/i);
  return matched?.[1] ?? escapeHtml(shikiHtml);
}

function escapeHtml(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
