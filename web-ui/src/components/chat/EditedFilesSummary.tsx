"use client";

import { ChevronDown, FileDiff, RotateCcw } from "lucide-react";
import type { AgentEvent } from "@/types/events";

type EditedFile = {
  path: string;
  additions: number;
  deletions: number;
  lines: DiffLine[];
};

type DiffLine = {
  kind: "add" | "remove" | "context" | "meta";
  oldLine?: number;
  newLine?: number;
  text: string;
};

export function EditedFilesSummary({ events }: { events: AgentEvent[] }) {
  const files = events
    .filter((event) => event.type === "file.edit")
    .map((event) => {
      const payload = event.payload as { path?: string; diff?: string; additions?: number; deletions?: number };
      return {
        path: String(payload.path ?? "unknown"),
        additions: Number(payload.additions ?? 0),
        deletions: Number(payload.deletions ?? 0),
        lines: parseUnifiedDiff(String(payload.diff ?? "")),
      };
    })
    .filter((file) => file.lines.length);

  if (!files.length) return null;

  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);

  return (
    <details className="edited-files-summary" open>
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
          <EditedFileBlock key={`${file.path}-${index}`} file={file} defaultOpen={index === files.length - 1} />
        ))}
      </div>
    </details>
  );
}

function EditedFileBlock({ file, defaultOpen }: { file: EditedFile; defaultOpen: boolean }) {
  return (
    <details className="edited-file-block" open={defaultOpen}>
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
          <div key={`${line.kind}-${index}-${line.oldLine ?? ""}-${line.newLine ?? ""}`} className={`edited-diff-line ${line.kind}`} role="row">
            <span className="edited-diff-num old">{line.oldLine ?? ""}</span>
            <span className="edited-diff-num new">{line.newLine ?? ""}</span>
            <code>{line.text || " "}</code>
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
      output.push({ kind: "meta", text: rawLine });
      continue;
    }
    if (rawLine.startsWith("+")) {
      output.push({ kind: "add", newLine, text: rawLine.slice(1) });
      newLine += 1;
      continue;
    }
    if (rawLine.startsWith("-")) {
      output.push({ kind: "remove", oldLine, text: rawLine.slice(1) });
      oldLine += 1;
      continue;
    }
    const text = rawLine.startsWith(" ") ? rawLine.slice(1) : rawLine;
    output.push({ kind: "context", oldLine, newLine, text });
    oldLine += 1;
    newLine += 1;
  }

  return output;
}
