import { encodeSse, replayEvents, sessionBus } from "@/lib/sse";
import { proxySse, shouldProxyToFcodeServer } from "@/lib/fcodeServerProxy";
import type { AgentEvent } from "@/types/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(request.url);
  const lastEventId = request.headers.get("Last-Event-ID") ?? url.searchParams.get("lastEventId");
  if (shouldProxyToFcodeServer()) {
    const query = new URLSearchParams();
    if (lastEventId) query.set("lastEventId", lastEventId);
    return proxySse(request, `/sessions/${encodeURIComponent(id)}/events/stream`, query);
  }
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      for (const event of replayEvents(id, lastEventId)) {
        controller.enqueue(encoder.encode(encodeSse(event)));
      }

      const bus = sessionBus(id);
      const onEvent = (event: AgentEvent) => {
        controller.enqueue(encoder.encode(encodeSse(event)));
      };
      bus.on("event", onEvent);

      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(": heartbeat\n\n"));
      }, 15_000);

      request.signal.addEventListener("abort", () => {
        bus.off("event", onEvent);
        clearInterval(heartbeat);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
