import type { AgentEvent } from "./events";

export type SessionStatus = "idle" | "streaming" | "waiting-approval" | "error";

export type Session = {
  id: string;
  threadId?: string;
  title: string;
  workspacePath: string;
  model: string;
  permission: "read-only" | "workspace-write" | "full-access";
  sessionSummary?: string;
  sessionFacts?: string[];
  compactSummary?: string;
  compactedAt?: string;
  contextUsagePct?: number;
  contextUsageTokens?: number;
  contextWindow?: number;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
};

export type Message = {
  id: string;
  sessionId: string;
  runId?: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  status: "streaming" | "done" | "error";
};

export type SessionDetail = {
  session: Session;
  messages: Message[];
  events: AgentEvent[];
};
