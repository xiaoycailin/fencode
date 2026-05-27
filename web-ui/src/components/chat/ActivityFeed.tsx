"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, FilePenLine, Globe2, Loader2, LockKeyhole, RefreshCcw, ShieldAlert, Terminal, XCircle } from "lucide-react";
import type { AgentEvent } from "@/types/events";

function eventLabel(event: AgentEvent): string {
  const p = event.payload as Record<string, unknown>;
  if (event.type === "cmd.start") {
    const cmd = String(p.command ?? "");
    return "Running: " + (cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd);
  }
  if (event.type === "cmd.done") {
    const exit = Number(p.exitCode ?? 0);
    const dur = p.duration ? ` (${p.duration}ms)` : "";
    const error = normalizedError(p);
    if (error) return `${error.code}: ${error.message}`;
    return exit === 0 ? `Completed${dur}` : `Failed exit ${exit}${dur}`;
  }
  if (event.type === "cmd.output") return "Command output";
  if (event.type === "cmd.error") return "Command error";
  if (event.type === "file.edit") {
    const path = String(p.path ?? "");
    const add = Number(p.additions ?? 0);
    const del = Number(p.deletions ?? 0);
    const name = path.split(/[\\/]/).at(-1) ?? path;
    return `Edited ${name}  +${add} -${del}`;
  }
  if (event.type === "file.create") return `Created: ${String(p.path ?? "")}`;
  if (event.type === "file.delete") return `Deleted: ${String(p.path ?? "")}`;
  if (event.type === "file.rename") return `Renamed: ${p.oldPath} -> ${p.newPath}`;
  if (event.type.startsWith("web.")) return `Search: ${String(p.query ?? p.count ?? "")}`;
  if (event.type.startsWith("permission.")) return `Permission: ${String(p.action ?? p.message ?? "")}`;
  if (event.type === "approval.requested") return `Approval required: ${String(p.command ?? "")}`;
  if (event.type === "approval.resolved") return `Approval ${String(p.decision ?? p.status ?? "resolved")}`;
  if (event.type === "session.error") return String(p.message ?? "Session error");
  if (event.type === "session.done") return String(p.message ?? "Session done");
  if (event.type.startsWith("thinking.")) return String(p.message ?? "Thinking");
  if (event.type.startsWith("tool.")) {
    const error = normalizedError(p);
    if (error) return `${error.code}: ${error.message}`;
    if ((p.tool as string | undefined) === "system.self-heal") {
      return String(p.message ?? (event.type === "tool.start" ? "Auto-retry triggered" : "Recovered with new thread"));
    }
    const t = (p as { tool?: string }).tool ?? event.type;
    return `Tool: ${t}`;
  }
  return event.type;
}

function iconFor(event: AgentEvent) {
  if (event.type.startsWith("cmd.")) return Terminal;
  if (event.type.startsWith("file.")) return FilePenLine;
  if (event.type.startsWith("web.")) return Globe2;
  if (event.type.startsWith("permission.") || event.type.startsWith("approval.")) return event.type === "approval.requested" ? ShieldAlert : LockKeyhole;
  if ((event.payload as { tool?: string }).tool === "system.self-heal") return RefreshCcw;
  if (event.type.endsWith(".error") || event.type === "session.error") return XCircle;
  return CheckCircle2;
}

function renderBody(event: AgentEvent, allEvents: AgentEvent[]): string {
  const p = event.payload as Record<string, unknown>;
  if (event.type === "cmd.start") {
    const pid = Number(p.pid ?? 0);
    const command = String(p.command ?? "");
    const cwd = String(p.cwd ?? "");
    const shell = String(p.shell ?? "");
    const output = allEvents
      .filter((entry) => entry.type === "cmd.output" && Number((entry.payload as { pid?: number }).pid ?? 0) === pid)
      .map((entry) => String((entry.payload as { chunk?: string }).chunk ?? ""))
      .join("")
      .trim();
    return [
      `command: ${command}`,
      shell ? `shell: ${shell}` : "",
      cwd ? `cwd: ${cwd}` : "",
      "",
      output ? output : "(waiting output...)",
    ].filter(Boolean).join("\n");
  }
  if (event.type === "cmd.done" || event.type === "cmd.output") {
    const error = normalizedError(p);
    if (error) return renderError(error);
    const raw = String(p.fullOutput ?? p.chunk ?? "");
    if (!raw.trim()) return "(empty output)";
    const lines = raw.split("\n");
    const MAX = 50;
    const head = lines.slice(0, MAX).join("\n");
    return lines.length > MAX ? head + `\n... (${lines.length - MAX} more lines)` : head;
  }
  if (event.type === "file.edit") {
    const diff = String(p.diff ?? "");
    if (!diff.trim()) return "(no diff)";
    const lines = diff.split("\n");
    const MAX = 40;
    const head = lines.slice(0, MAX).join("\n");
    return lines.length > MAX ? head + `\n... (${lines.length - MAX} more lines)` : head;
  }
  if (event.type === "web.search.start") {
    const query = String(p.query ?? "");
    const engine = String(p.engine ?? "");
    const latestResult = [...allEvents].reverse().find((entry) => entry.type === "web.search.result");
    const results = (latestResult?.payload as { results?: Array<{ title?: string; url?: string }> } | undefined)?.results ?? [];
    const lines = results.slice(0, 8).map((item, index) => `${index + 1}. ${item.title ?? "(no title)"}\n   ${item.url ?? ""}`);
    return [
      query ? `query: ${query}` : "",
      engine ? `engine: ${engine}` : "",
      "",
      lines.length ? lines.join("\n") : "(waiting results...)",
    ].filter(Boolean).join("\n");
  }
  if ((p.tool as string | undefined) === "system.self-heal") {
    return [
      `status: ${String(p.status ?? "")}`,
      `message: ${String(p.message ?? "")}`,
    ].filter(Boolean).join("\n");
  }
  if (event.type.startsWith("approval.")) {
    return [
      `command: ${String(p.command ?? "")}`,
      `status: ${String(p.status ?? "")}`,
      p.decision ? `decision: ${String(p.decision)}` : "",
      p.reason ? `reason: ${String(p.reason)}` : "",
      p.hint ? `hint: ${String(p.hint)}` : "",
    ].filter(Boolean).join("\n");
  }
  const error = normalizedError(p);
  if (error) return renderError(error);
  return JSON.stringify(p, null, 2);
}

function isExpandable(type: string) {
  return type === "cmd.start" || type === "cmd.done" || type === "cmd.output" || type === "file.edit" || type === "web.search.start" || type === "web.search.result" || type.endsWith(".error") || type.startsWith("tool.") || type.startsWith("approval.");
}

function normalizedError(payload: Record<string, unknown>) {
  const nested = payload.error as { code?: string; message?: string; hint?: string } | undefined;
  if (nested?.message) return {
    code: nested.code || "error",
    message: nested.message,
    hint: nested.hint,
  };
  const message = typeof payload.message === "string" ? payload.message : "";
  if (!message) return null;
  return {
    code: typeof payload.code === "string" ? payload.code : "error",
    message,
    hint: typeof payload.hint === "string" ? payload.hint : undefined,
  };
}

function renderError(error: { code: string; message: string; hint?: string }) {
  return [
    `code: ${error.code}`,
    `message: ${error.message}`,
    error.hint ? `hint: ${error.hint}` : "",
  ].filter(Boolean).join("\n");
}

export function ActivityFeed({
  events,
  active = false,
  onApprovalDecision,
}: {
  events: AgentEvent[];
  active?: boolean;
  onApprovalDecision?: (decision: "approved" | "rejected") => void | Promise<void>;
}) {
  const visible = useMemo(
    () => compactVisibleEvents(
      events.filter((event) => shouldDisplayEvent(event)),
    ),
    [events],
  );
  const isDone = visible.some((e) => e.type === "session.done" || e.type === "session.error");
  const isImagegenRunning = active && !isDone && visible.some((event) => {
    const payload = event.payload as { tool?: string };
    return event.type === "tool.start" && payload.tool === "imagegen";
  });
  const [open, setOpen] = useState(active || !isDone);
  useEffect(() => {
    setOpen(active || !isDone);
  }, [active, isDone, visible.length]);
  if (!visible.length) return null;
  if (isImagegenRunning) return <ImagegenLoadingCard />;

  const failed = visible.some((e) => e.type === "session.error");
  const approvalPending = findPendingApproval(visible);
  const summaryLine = failed ? "Failed" : approvalPending ? "Waiting approval" : visible.at(-1)?.type === "session.done" ? "Completed" : isDone ? "Finished" : "Working";

  return (
    <details
      className="assistant-work"
      open={open}
      onToggle={(event) => {
        if (event.target !== event.currentTarget) return;
        setOpen((event.currentTarget as HTMLDetailsElement).open);
      }}
    >
      <summary className="assistant-work-summary">
        <span>{summaryLine}</span>
        <ChevronDown className="assistant-work-chevron" size={14} />
      </summary>
      <div className="divider" />
      <div className="activity-feed">
        {approvalPending ? (
          <div className="approval-card">
            <div>
              <strong>Approval required</strong>
              <p>{String((approvalPending.payload as Record<string, unknown>).command ?? "")}</p>
            </div>
            <div className="approval-actions">
              <button type="button" className="ghost-button" onClick={() => void onApprovalDecision?.("rejected")}>Reject</button>
              <button type="button" className="primary-button" onClick={() => void onApprovalDecision?.("approved")}>Approve</button>
            </div>
          </div>
        ) : null}
        {visible.map((event) => {
          const Icon = iconFor(event);
          const canExpand = isExpandable(event.type);
          return (
            <details key={event.id} className="activity-item">
              <summary className="activity-summary">
                <Icon size={14} />
                <span className="activity-label">{eventLabel(event)}</span>
                <span className="activity-time">{new Date(event.timestamp).toLocaleTimeString()}</span>
                {canExpand ? <ChevronDown className="activity-chevron" size={13} /> : null}
              </summary>
              {canExpand ? (
                <div className="activity-body">
                  <pre>{renderBody(event, events)}</pre>
                </div>
              ) : null}
            </details>
          );
        })}
        {active && !isDone ? (
          <div className="activity-thinking">
            <Loader2 size={13} />
            <span>Thinking<span className="dots-anim">...</span></span>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function isCompactContextEvent(event: AgentEvent) {
  const payload = event.payload as { tool?: string };
  return event.type.startsWith("tool.") && payload.tool === "context.compact";
}

function shouldDisplayEvent(event: AgentEvent) {
  if (event.type === "message.delta" || event.type === "message.done" || event.type === "todo.progress" || event.type === "heartbeat" || event.type === "cmd.output") return false;
  if (isCompactContextEvent(event)) return false;
  if (event.type === "thinking.done") return false;
  if (event.type.startsWith("thinking.")) {
    const message = String((event.payload as { message?: string }).message ?? "");
    return message.startsWith("Starting") || message.startsWith("Workspace:") || message.startsWith("Permission:");
  }
  if (event.type.startsWith("tool.")) {
    const tool = String((event.payload as { tool?: string }).tool ?? "");
    if (!tool) return false;
    if (tool === "runtime.context" || tool === "provider.request") return false;
    return true;
  }
  if (event.type === "session.done") return true;
  if (event.type === "session.error") return true;
  if (event.type.startsWith("cmd.") || event.type.startsWith("file.") || event.type.startsWith("web.") || event.type.startsWith("permission.") || event.type.startsWith("approval.")) return true;
  return false;
}

function compactVisibleEvents(events: AgentEvent[]) {
  const output: AgentEvent[] = [];
  let doneIncluded = false;
  for (const event of events) {
    if (event.type === "session.done") {
      if (doneIncluded) continue;
      doneIncluded = true;
    }
    const prev = output.at(-1);
    if (prev && prev.type === event.type) {
      const prevPayload = JSON.stringify(prev.payload);
      const nextPayload = JSON.stringify(event.payload);
      if (prevPayload === nextPayload) continue;
    }
    output.push(event);
  }
  return output;
}

function findPendingApproval(events: AgentEvent[]) {
  const requested = [...events].reverse().find((event) => event.type === "approval.requested");
  if (!requested) return null;
  const resolvedAfterRequest = events.some((event) =>
    event.type === "approval.resolved" && event.runId === requested.runId && event.timestamp >= requested.timestamp,
  );
  return resolvedAfterRequest ? null : requested;
}

function ImagegenLoadingCard() {
  const size = 17;
  const center = (size - 1) / 2;
  return (
    <div className="imagegen-loading-card">
      <strong>Membuat gambar</strong>
      <div className="imagegen-dot-field" aria-hidden="true">
        {Array.from({ length: size * size }, (_, index) => {
          const x = index % size;
          const y = Math.floor(index / size);
          const distance = Math.hypot(x - center, y - center);
          const angle = Math.atan2(y - center, x - center);
          const drift = 1.2 + ((x * 3 + y * 5) % 5) * 0.22;
          const opacity = Math.max(0.12, 0.5 - distance * 0.025);
          return (
            <span
              key={index}
              style={{
                "--dx": `${Math.cos(angle) * drift}px`,
                "--dy": `${Math.sin(angle) * drift}px`,
                "--s": `${0.72 + ((x + y) % 4) * 0.08}`,
                "--o": `${opacity}`,
                "--d": `${2.4 + ((x * 7 + y * 11) % 6) * 0.12}s`,
                "--delay": `${distance * 0.075 + ((x * 2 + y * 3) % 5) * 0.035}s`,
              } as React.CSSProperties}
            />
          );
        })}
      </div>
    </div>
  );
}
