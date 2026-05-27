import { readFcodeConfig } from "./fcodeConfig";
import { normalizeFcodeServerEvent, normalizeFcodeServerJson } from "./fcodeServerCompat";
import type { AgentEvent } from "@/types/events";

function engineBaseUrl() {
  const fromEnv = process.env.FCODE_SERVER_BASE_URL || process.env.NEXT_PUBLIC_FCODE_SERVER_BASE_URL || "";
  const fromConfig = readFcodeConfig().engineServerUrl.trim();
  const selected = fromEnv || fromConfig || "http://127.0.0.1:32188";
  return selected.replace(/\/+$/, "");
}

export function shouldProxyToFcodeServer() {
  return process.env.FCODE_BACKEND === "server" || Boolean(readFcodeConfig().engineServerUrl.trim());
}

export function buildFcodeServerUrl(path: string, query?: URLSearchParams) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const base = `${engineBaseUrl()}${normalized}`;
  if (!query || ![...query.keys()].length) return base;
  return `${base}?${query.toString()}`;
}

export async function proxyJson(request: Request, path: string, init: { method?: string; body?: unknown } = {}) {
  const method = init.method ?? request.method;
  const response = await fetch(buildFcodeServerUrl(path), {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  });
  const contentType = response.headers.get("content-type") || "application/json; charset=utf-8";
  const body = await response.text();
  const normalized = contentType.includes("application/json")
    ? normalizeFcodeServerJson(path, body)
    : body;
  return new Response(normalized, {
    status: response.status,
    headers: { "Content-Type": contentType },
  });
}

export async function proxySse(request: Request, path: string, query?: URLSearchParams) {
  const upstream = await fetch(buildFcodeServerUrl(path, query), {
    method: "GET",
    headers: {
      Accept: "text/event-stream",
      "Last-Event-ID": request.headers.get("Last-Event-ID") ?? "",
    },
    cache: "no-store",
  });
  if (!upstream.body) {
    return new Response("Upstream stream unavailable", { status: 502 });
  }
  const normalizedStream = relaySseStream(upstream.body, request.signal);
  return new Response(normalizedStream, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") || "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function relaySseStream(stream: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const transformed = transformSseStream(stream);
  const reader = transformed.getReader();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const abort = () => {
        reader.cancel().catch(() => undefined);
        controller.close();
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) controller.enqueue(value);
        }
        controller.close();
      } catch (error) {
        if (!isAbortLike(error)) controller.error(error);
      } finally {
        signal.removeEventListener("abort", abort);
        reader.releaseLock();
      }
    },
    cancel() {
      return reader.cancel().catch(() => undefined);
    },
  });
}

function transformSseStream(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        controller.enqueue(encoder.encode(normalizeSseFrame(frame)));
        index = buffer.indexOf("\n\n");
      }
    },
    flush(controller) {
      if (!buffer.trim()) return;
      controller.enqueue(encoder.encode(normalizeSseFrame(buffer)));
    },
  }));
}

function normalizeSseFrame(frame: string) {
  if (!frame.includes("data:")) return `${frame}\n\n`;
  const rows = frame.split("\n");
  const output: string[] = [];
  for (const row of rows) {
    if (!row.startsWith("data:")) {
      output.push(row);
      continue;
    }
    const raw = row.slice(5).trim();
    try {
      const parsed = JSON.parse(raw) as AgentEvent;
      const normalized = normalizeFcodeServerEvent(parsed);
      output.push(`data: ${JSON.stringify(normalized)}`);
    } catch {
      output.push(row);
    }
  }
  return `${output.join("\n")}\n\n`;
}

function isAbortLike(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.includes("aborted")
    || message.includes("AbortError")
    || message.includes("ECONNRESET")
    || message.includes("terminated");
}
