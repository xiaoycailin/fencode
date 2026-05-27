import { EventEmitter } from "node:events";
import { addEvent, listEvents } from "./store.js";
import { makeId, nowIso } from "./id.js";
import type { AgentEvent } from "./types.js";

const buses = new Map<string, EventEmitter>();

export function sessionBus(sessionId: string) {
  let bus = buses.get(sessionId);
  if (!bus) {
    bus = new EventEmitter();
    bus.setMaxListeners(200);
    buses.set(sessionId, bus);
  }
  return bus;
}

export function publishEvent(
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
  meta: Pick<AgentEvent, "runId" | "messageId"> = {},
) {
  const event: AgentEvent = {
    id: makeId("evt"),
    type,
    sessionId,
    ...meta,
    timestamp: nowIso(),
    payload,
  };
  addEvent(event);
  sessionBus(sessionId).emit("event", event);
  return event;
}

export function replayEvents(sessionId: string, lastEventId?: string | null) {
  return listEvents(sessionId, lastEventId);
}

export function encodeSse(event: AgentEvent) {
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

