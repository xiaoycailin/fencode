import { EventEmitter } from "node:events";
import { addEvent } from "./db";
import { makeId, nowIso } from "./id";
import type { AgentEvent, AgentEventType, EventPayload } from "@/types/events";

type SessionEmitter = EventEmitter & { setMaxListeners(count: number): SessionEmitter };

const globalBus = globalThis as typeof globalThis & {
  __fcodeBus?: Map<string, SessionEmitter>;
  __fcodeRing?: Map<string, AgentEvent[]>;
};

function busMap() {
  globalBus.__fcodeBus ??= new Map();
  return globalBus.__fcodeBus;
}

function ringMap() {
  globalBus.__fcodeRing ??= new Map();
  return globalBus.__fcodeRing;
}

export function sessionBus(sessionId: string) {
  const buses = busMap();
  let bus = buses.get(sessionId);
  if (!bus) {
    bus = new EventEmitter() as SessionEmitter;
    bus.setMaxListeners(200);
    buses.set(sessionId, bus);
  }
  return bus;
}

export function publishEvent(
  sessionId: string,
  type: AgentEventType,
  payload: EventPayload,
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
  const ring = ringMap();
  ring.set(sessionId, [...(ring.get(sessionId) ?? []), event].slice(-1000));
  addEvent(event);
  sessionBus(sessionId).emit("event", event);
  if (type !== "todo.progress") {
    void import("./todoProgress").then(({ syncTodoProgressFromAgentEvent }) => {
      syncTodoProgressFromAgentEvent(sessionId, event);
    });
  }
  return event;
}

export function replayEvents(sessionId: string, lastEventId?: string | null) {
  const events = ringMap().get(sessionId) ?? [];
  if (!lastEventId) return events.slice(-100);
  const index = events.findIndex((event) => event.id === lastEventId);
  return index >= 0 ? events.slice(index + 1) : events.slice(-100);
}

export function encodeSse(event: AgentEvent) {
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}
