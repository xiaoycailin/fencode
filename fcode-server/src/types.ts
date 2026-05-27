export type SessionStatus = "idle" | "streaming" | "waiting-approval" | "error";

export type Permission = "read-only" | "workspace-write" | "full-access";

export type Session = {
  id: string;
  threadId?: string;
  title: string;
  workspacePath: string;
  model: string;
  permission: Permission;
  activeGoalObjective?: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  contextUsagePct?: number;
  contextUsageTokens?: number;
  contextWindow?: number;
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

export type AgentEvent = {
  id: string;
  type: string;
  sessionId: string;
  runId?: string;
  messageId?: string;
  timestamp: string;
  payload: Record<string, unknown>;
};

export type TreeNode = {
  id: string;
  name: string;
  path: string;
  type: "file" | "directory";
  children?: TreeNode[];
};
