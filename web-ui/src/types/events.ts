export type AgentEventType =
  | "message.delta"
  | "message.done"
  | "thinking.start"
  | "thinking.delta"
  | "thinking.done"
  | "tool.start"
  | "tool.output"
  | "tool.done"
  | "tool.error"
  | "file.create"
  | "file.edit"
  | "file.delete"
  | "file.rename"
  | "cmd.start"
  | "cmd.output"
  | "cmd.done"
  | "cmd.error"
  | "web.search.start"
  | "web.search.result"
  | "web.search.done"
  | "git.operation"
  | "mcp.call"
  | "permission.request"
  | "permission.response"
  | "todo.progress"
  | "approval.requested"
  | "approval.resolved"
  | "session.error"
  | "session.done"
  | "heartbeat";

export type EventPayload =
  | { content: string; role: "assistant" | "user" }
  | { path: string; content?: string; language?: string; size?: number; expandable?: boolean }
  | { path: string; diff: string; hunks: number; additions: number; deletions: number; expandable: boolean }
  | { path: string; contentSnapshot: string; expandable: boolean }
  | { oldPath: string; newPath: string }
  | { command: string; shell: "bash" | "powershell" | "zsh" | "cmd"; cwd: string; pid: number }
  | { chunk: string; stream: "stdout" | "stderr"; pid: number }
  | { pid: number; exitCode: number; duration: number; fullOutput: string; expandable: boolean }
  | { query: string; engine: string }
  | { results: Array<{ title: string; url: string; snippet: string }>; count: number }
  | { id: string; action: string; risk: "low" | "medium" | "high"; details: string; timeout: number }
  | { operation: "commit" | "push" | "pull" | "checkout" | "merge" | "rebase"; details: Record<string, string>; success: boolean; error?: string }
  | { message: string }
  | Record<string, unknown>;

export type AgentEvent = {
  id: string;
  type: AgentEventType;
  sessionId: string;
  runId?: string;
  messageId?: string;
  timestamp: string;
  payload: EventPayload;
};
