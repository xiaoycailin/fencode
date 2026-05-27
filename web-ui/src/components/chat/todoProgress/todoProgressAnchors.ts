import type { TodoProgressState } from "./todoProgressReducer";

type AnchorMessage = {
  id: string;
  runId?: string;
  role: "user" | "assistant" | "system";
};

export function buildTodoProgressAnchors(messages: AnchorMessage[], state: TodoProgressState) {
  const latestByRun = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "user" || !message.runId || !state.runs[message.runId]) continue;
    latestByRun.set(message.runId, message.id);
  }
  const anchors: Record<string, string> = {};
  for (const [runId, messageId] of latestByRun.entries()) anchors[messageId] = runId;
  return anchors;
}
