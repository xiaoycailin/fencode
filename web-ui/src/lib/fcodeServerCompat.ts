import type { AgentEvent } from "@/types/events";

export function normalizeFcodeServerJson(path: string, text: string) {
  if (!text.trim()) return text;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return text;
  }

  if (path.includes("/events")) return JSON.stringify(mapEventsPayload(payload));
  if (path.includes("/sessions/") && !path.endsWith("/messages")) return JSON.stringify(mapSessionDetailPayload(payload));
  return JSON.stringify(mapErrorPayload(payload));
}

export function normalizeFcodeServerEvent(event: AgentEvent): AgentEvent {
  return {
    ...event,
    payload: normalizeEventPayload(event),
  };
}

function mapSessionDetailPayload(payload: unknown) {
  if (!isRecord(payload)) return payload;
  const events = Array.isArray(payload.events)
    ? payload.events.map((event) => normalizeFcodeServerEvent(event as AgentEvent))
    : payload.events;
  return { ...payload, events };
}

function mapEventsPayload(payload: unknown) {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return payload;
  return {
    ...payload,
    data: payload.data.map((event) => normalizeFcodeServerEvent(event as AgentEvent)),
  };
}

function mapErrorPayload(payload: unknown) {
  if (!isRecord(payload)) return payload;
  if (isRecord(payload.error)) return payload;
  if (typeof payload.error === "string") {
    return {
      ...payload,
      error: {
        code: inferHttpErrorCode(payload.error),
        message: payload.error,
      },
    };
  }
  return payload;
}

function normalizeEventPayload(event: AgentEvent) {
  const payload = (isRecord(event.payload) ? event.payload : {}) as Record<string, unknown>;
  if (event.type === "cmd.done") {
    return {
      pid: numberOr(payload.pid, 0),
      exitCode: numberOr(payload.exitCode, 0),
      duration: numberOr(payload.duration, 0),
      fullOutput: String(payload.fullOutput ?? ""),
      expandable: Boolean(payload.expandable ?? String(payload.fullOutput ?? "").length > 800),
      command: payload.command,
      error: payload.error,
    };
  }
  if (event.type === "cmd.start") {
    return {
      command: String(payload.command ?? ""),
      shell: normalizeShell(payload.shell),
      cwd: String(payload.cwd ?? ""),
      pid: numberOr(payload.pid, 0),
    };
  }
  if (event.type === "file.edit") {
    const diff = String(payload.diff ?? "");
    return {
      path: String(payload.path ?? ""),
      diff,
      hunks: numberOr(payload.hunks, Math.max(1, (diff.match(/^@@/gm) ?? []).length)),
      additions: numberOr(payload.additions, 0),
      deletions: numberOr(payload.deletions, 0),
      expandable: Boolean(payload.expandable ?? diff.length > 400),
    };
  }
  if (event.type === "tool.done") {
    return {
      tool: String(payload.tool ?? ""),
      output: String(payload.output ?? ""),
      duration: numberOr(payload.duration, 0),
      status: String(payload.status ?? "completed"),
      error: payload.error,
    };
  }
  if (event.type === "tool.start") {
    return {
      tool: String(payload.tool ?? ""),
      input: payload.input ?? {},
      status: String(payload.status ?? "running"),
      message: payload.message,
    };
  }
  if (event.type === "tool.error") {
    const error = isRecord(payload.error) ? payload.error : {};
    const message = String(error.message ?? payload.message ?? "Tool failed");
    return {
      tool: String(payload.tool ?? ""),
      status: "error",
      message,
      error: {
        code: String(error.code ?? payload.code ?? "tool_failed"),
        message,
        hint: error.hint ?? payload.hint,
      },
    };
  }
  if (event.type.startsWith("thinking.") || event.type.startsWith("session.")) {
    return { message: String(payload.message ?? "") };
  }
  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function numberOr(value: unknown, fallback: number) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function normalizeShell(value: unknown) {
  const raw = String(value || "powershell").toLowerCase();
  if (raw === "bash" || raw === "zsh" || raw === "cmd") return raw;
  return "powershell";
}

function inferHttpErrorCode(message: unknown) {
  const value = String(message || "").toLowerCase();
  if (value.includes("session not found")) return "session_not_found";
  if (value.includes("already running")) return "session_busy";
  if (value.includes("content is required")) return "bad_request";
  if (value.includes("not found")) return "not_found";
  return "http_error";
}
