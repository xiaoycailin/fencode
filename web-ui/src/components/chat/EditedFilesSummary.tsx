"use client";

import { ChevronDown, FileDiff, RotateCcw } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import { extractCodeInnerHtml, highlightCodeToHtml } from "@/lib/codeTheme";
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

export function EditedFilesSummary({
  events,
  workspacePath,
  sessionId,
  runId,
}: {
  events: AgentEvent[];
  workspacePath?: string;
  sessionId: string;
  runId?: string;
}) {
  const files = useMemo(
    () => {
      const merged = new Map<string, EditedFile>();
      for (const event of events) {
        if (event.type !== "file.edit") continue;
        const payload = event.payload as { path?: string; diff?: string; additions?: number; deletions?: number };
        const path = String(payload.path ?? "unknown");
        const diff = String(payload.diff ?? "");
        const parsedLines = parseUnifiedDiff(diff);
        const lines = parsedLines.length ? parsedLines : fallbackLinesFromDiff(diff, Number(payload.additions ?? 0), Number(payload.deletions ?? 0));
        const inferred = inferDisplayCounts(diff, Number(payload.additions ?? 0), Number(payload.deletions ?? 0), lines);
        const current = merged.get(path);
        if (!current) {
          merged.set(path, {
            path,
            additions: inferred.additions,
            deletions: inferred.deletions,
            lines,
            language: languageFromPath(path),
          });
          continue;
        }
        current.additions += inferred.additions;
        current.deletions += inferred.deletions;
        current.lines = [...current.lines, ...lines];
      }
      return [...merged.values()].filter((file) => file.lines.length || file.additions > 0 || file.deletions > 0);
    },
    [events],
  );

  if (!files.length) return null;

  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);

  async function undoRun(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (!runId) return;
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/undo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId }),
    });
  }

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
          <button type="button" className="edited-files-link" disabled={!runId} onClick={(event) => void undoRun(event)}>
            Undo <RotateCcw size={12} />
          </button>
          <ChevronDown className="edited-files-chevron" size={14} />
        </span>
      </summary>
      <div className="edited-files-body">
        {files.map((file, index) => (
          <EditedFileBlock key={`${file.path}-${index}`} file={file} workspacePath={workspacePath} />
        ))}
      </div>
    </details>
  );
}

const EditedFileBlock = memo(function EditedFileBlock({ file, workspacePath }: { file: EditedFile; workspacePath?: string }) {
  const [highlighted, setHighlighted] = useState<string[]>([]);
  const [numberedLines, setNumberedLines] = useState(file.lines);
  const [isDark, setIsDark] = useState(true);
  useEffect(() => {
    const refresh = () => setIsDark(document.documentElement.classList.contains("dark"));
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setNumberedLines(file.lines);
    if (!workspacePath || file.lines.every((line) => line.lineNo)) return;
    const params = new URLSearchParams({ root: workspacePath, path: file.path });
    let cancelled = false;
    void fetch(`/api/workspace/file?${params.toString()}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((data: { content?: string } | null) => {
        if (cancelled || !data?.content) return;
        setNumberedLines(assignLineNumbersFromContent(file.lines, data.content));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [file.lines, file.path, workspacePath]);

  useEffect(() => {
    let cancelled = false;
    const code = numberedLines.map((line) => line.text || " ").join("\n");
    void highlightCodeToHtml(code, file.language, isDark)
      .then((html) => {
        if (cancelled) return;
        setHighlighted(extractCodeInnerHtml(html).split(/\r?\n/));
      })
      .catch(() => {
        if (!cancelled) setHighlighted([]);
      });
    return () => {
      cancelled = true;
    };
  }, [file.language, numberedLines, isDark]);

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
        {(numberedLines.length ? numberedLines : [{ kind: "context", sign: " ", text: "Diff preview unavailable" } as DiffLine]).map((line, index) => (
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
});

function parseUnifiedDiff(diff: string): DiffLine[] {
  const output: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let hasHunk = false;

  for (const rawLine of diff.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith("diff --git") || rawLine.startsWith("index ") || rawLine.startsWith("--- ") || rawLine.startsWith("+++ ")) continue;
    const hunk = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      hasHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (rawLine.startsWith("+")) {
      output.push({ kind: "add", lineNo: hasHunk ? newLine : undefined, sign: "+", text: rawLine.slice(1) });
      newLine += 1;
      continue;
    }
    if (rawLine.startsWith("-")) {
      output.push({ kind: "remove", lineNo: hasHunk ? oldLine : undefined, sign: "-", text: rawLine.slice(1) });
      oldLine += 1;
      continue;
    }
    oldLine += 1;
    newLine += 1;
  }

  return output;
}

function fallbackLinesFromDiff(diff: string, additions: number, deletions: number): DiffLine[] {
  const rawLines = diff
    .split(/\r?\n/)
    .map((line) => line.replace(/\t/g, "  ").trimEnd())
    .filter((line) => line && !line.startsWith("diff --git") && !line.startsWith("index "));
  const output: DiffLine[] = [];
  for (const line of rawLines) {
    if (isTruncatedMarker(line)) continue;
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) {
      output.push({ kind: "add", sign: "+", text: line.slice(1) });
      continue;
    }
    if (line.startsWith("-")) {
      output.push({ kind: "remove", sign: "-", text: line.slice(1) });
      continue;
    }
  }
  if (output.length) return output;
  const plainContext = rawLines
    .filter((line) => !isTruncatedMarker(line) && !line.startsWith("+++ ") && !line.startsWith("--- ") && !line.startsWith("@@"))
    .filter((line) => line.trim().length > 0);
  if (plainContext.length) {
    const expected = Math.max(additions + deletions, additions, deletions, plainContext.length);
    const maxPreviewLines = Math.min(Math.max(expected, 1), 220);
    return plainContext.slice(0, maxPreviewLines).map((text) => ({ kind: "context", sign: " ", text }));
  }
  if (diff.trim()) return [{ kind: "context", sign: " ", text: diff.trim().slice(0, 1200) }];
  if (additions > 0 || deletions > 0) return [{ kind: additions > 0 ? "add" : "remove", sign: additions > 0 ? "+" : "-", text: "Diff preview unavailable" }];
  return [];
}

function inferDisplayCounts(diff: string, additions: number, deletions: number, lines: DiffLine[]) {
  if (additions > 0 || deletions > 0) return { additions, deletions };
  const addFromSigns = diff.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const delFromSigns = diff.split(/\r?\n/).filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  if (addFromSigns > 0 || delFromSigns > 0) return { additions: addFromSigns, deletions: delFromSigns };
  const addFromLines = lines.filter((line) => line.kind === "add").length;
  const delFromLines = lines.filter((line) => line.kind === "remove").length;
  if (addFromLines > 0 || delFromLines > 0) return { additions: addFromLines, deletions: delFromLines };
  if (lines.length > 0) return { additions: lines.length, deletions: 0 };
  return { additions: 0, deletions: 0 };
}

function isTruncatedMarker(line: string) {
  return /^\s*\.\.\.\s+truncated\s*$/i.test(line) || /^\s*\.\.\.\s+\(\d+\s+chars\s+truncated\)\s*$/i.test(line);
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

function assignLineNumbersFromContent(lines: DiffLine[], content: string): DiffLine[] {
  const source = content.split(/\r?\n/);
  let cursor = 0;
  return lines.map((line) => {
    if (line.lineNo) return line;
    if (line.kind !== "add" && line.kind !== "context") return line;
    const target = line.text.trim();
    if (!target) return line;
    for (let index = cursor; index < source.length; index += 1) {
      if (source[index].trim() === target) {
        cursor = index + 1;
        return { ...line, lineNo: index + 1 };
      }
    }
    return line;
  });
}

function escapeHtml(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
