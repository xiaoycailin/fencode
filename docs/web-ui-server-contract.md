# Web UI Server Contract

Dokumen ini adalah kontrak minimal agar `web-ui` bisa connect ke otak mandiri lewat `baseUrl`.
Server boleh ditulis ulang ke Rust/Go nanti selama shape API ini tetap dijaga.

## Runtime Modes

`web-ui` harus bisa jalan dalam dua mode:

- `legacy`: Next API lokal tetap pakai bridge lama.
- `server`: Next API atau browser client meneruskan request ke `fcode-server` lewat `FCODE_SERVER_BASE_URL`.

Env yang disarankan:

```bash
FCODE_BACKEND=server
FCODE_SERVER_BASE_URL=http://127.0.0.1:32188
```

Jangan pakai port `20128`.

## Build Note

- Di Windows, `web-ui` sementara **tidak** pakai Next `output: "standalone"`.
- Alasan: Next file tracing masih salah menangani absolute path `C:\...\.fencode` dan memicu warning copy traced files.
- Build Windows tetap pakai `.next-v2` biasa.
- Packaging Windows nanti perlu bundling runtime dengan script copy/deploy sendiri, bukan standalone bawaan Next.

Home engine default:

- `C:\Users\ADMIN\.fencode` (atau `%USERPROFILE%\.fencode`)
- bisa override pakai `FENCODE_HOME`
- `DEFAULT_WORKSPACE_PATH` opsional untuk override workspace root

Config runtime field:

- `engineServerUrl` di `~/.fencode/config.json` jadi source URL otak server.

## Response Shape

Gunakan JSON stabil:

```json
{ "data": [] }
```

Untuk create/update:

```json
{ "session": {} }
```

Untuk error:

```json
{ "error": "message" }
```

## Core Types

```ts
type SessionStatus = "idle" | "streaming" | "waiting-approval" | "error";

type Session = {
  id: string;
  title: string;
  workspacePath: string;
  model: string;
  permission: "read-only" | "workspace-write" | "full-access";
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  threadId?: string;
  contextUsagePct?: number;
  contextUsageTokens?: number;
  contextWindow?: number;
};

type Message = {
  id: string;
  sessionId: string;
  runId?: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  status: "streaming" | "done" | "error";
};

type AgentEvent = {
  id: string;
  type: string;
  sessionId: string;
  runId?: string;
  messageId?: string;
  timestamp: string;
  payload: Record<string, unknown>;
};
```

## Required Endpoints

### Health

- `GET /health`
- Response: `{ "ok": true, "name": "fcode-server", "version": "0.1.0" }`

### Sessions

- `GET /sessions`
- Response: `{ "data": Session[] }`

- `POST /sessions`
- Body: `{ "title"?: string, "workspacePath"?: string, "model"?: string, "permission"?: string }`
- Response: `{ "session": Session }`

- `GET /sessions/:id`
- Response: `{ "session": Session, "messages": Message[], "events": AgentEvent[] }`

- `PATCH /sessions/:id`
- Body: partial session fields
- Response: `{ "session": Session }`

- `DELETE /sessions/:id`
- Response: `{ "ok": true }`

### Messages And Runs

- `GET /sessions/:id/messages`
- Response: `{ "data": Message[] }`

- `POST /sessions/:id/messages`
- Body: `{ "content": string, "runId"?: string, "input"?: unknown[] }`
- Response: `{ "message": Message }` with HTTP `202`

Expected behavior:

1. Store user message.
2. Set session `status = "streaming"`.
3. Emit events through stream.
4. Store assistant message.
5. Set session `status = "idle"` when done.

- `POST /sessions/:id/interrupt`
- Response: `{ "interrupted": boolean }`

- `POST /sessions/:id/approval`
- Body: `{ "decision": "approved" | "rejected" }`
- Response: `{ "ok": true, "decision": "approved" | "rejected", "runId": string }`

- `POST /sessions/:id/compact`
- Body: `{ "mode"?: "manual" | "auto" }`
- Response: `{ "ok": true }`

### Event Stream

- `GET /sessions/:id/events`
- Response: `{ "data": AgentEvent[] }`

- `GET /sessions/:id/events/stream?lastEventId=...`
- SSE response.

SSE frame:

```txt
id: evt_xxx
data: {"id":"evt_xxx","type":"message.delta",...}
```

Minimal event types yang dibutuhkan UI:

- `thinking.start`
- `thinking.delta`
- `thinking.done`
- `message.delta`
- `message.done`
- `cmd.start`
- `cmd.output`
- `cmd.done`
- `file.edit`
- `tool.start`
- `tool.done`
- `session.error`
- `session.done`
- `approval.requested`
- `approval.resolved`
- `heartbeat`

## Web UI Proxy Core

Route internal `web-ui` yang wajib proxy ke `fcode-server` pada mode server:

- `/api/sessions`
- `/api/sessions/:id`
- `/api/sessions/:id/messages`
- `/api/sessions/:id/stream`
- `/api/sessions/:id/interrupt`
- `/api/sessions/:id/approval`
- `/api/sessions/:id/compact`

### Workspace

- `GET /workspace/tree?root=...&depth=3&includeIgnored=0`
- Response: `{ "root": string, "data": TreeNode[] }`

- `GET /workspace/file?root=...&path=...`
- Response: `{ "path": string, "content": string, "language": string }`

- `POST /workspace/file`
- Body: `{ "root": string, "path": string, "content": string }`
- Response: `{ "ok": true, "path": string }`

- `DELETE /workspace/file?root=...&path=...`
- Response: `{ "ok": true }`

### Git

- `GET /git/status?root=...`
- Response should match current web-ui shape:

```ts
type GitStatus = {
  isRepo: boolean;
  root: string;
  branch?: string;
  changedFiles?: number;
  stagedFiles?: number;
  unstagedFiles?: number;
  untrackedFiles?: number;
  lastCommit?: string;
  files?: Array<{ path: string; working_dir: string; index: string }>;
  error?: string;
};
```

- `GET /git/diff?root=...&path=...`
- Response: `{ "root": string, "path": string | null, "diff": string }`

- `POST /git/stage`
- Body: `{ "root": string, "paths": string[] }`
- Response: `{ "ok": true }`

- `POST /git/commit`
- Body: `{ "root": string, "message": string }`
- Response: `{ "ok": true, "commit"?: string, "summary"?: unknown }`

## Compatibility Rule

`web-ui` should depend on this HTTP/SSE contract, not on implementation details like JSON-RPC, `fcode.exe app-server`, Node, Rust, or Go.

The server owns:

- sessions
- messages
- events
- run lifecycle
- workspace file operations
- git operations
- future tools and agent loop

The UI owns:

- rendering
- optimistic user message UX
- local view state
- selected workspace/model preferences

## Docs Upkeep

Setiap perubahan penting pada kontrak ini wajib ditulis di docs pada turn yang sama.

Contoh yang wajib update docs:

- endpoint baru atau response shape berubah
- event type baru yang dibutuhkan UI
- port/default env berubah
- lifecycle server berubah
- state ownership pindah antara UI dan server
- implementasi pindah dari Node/TS ke Rust/Go

Jangan mengandalkan chat history sebagai sumber kebenaran.

## Engine Home Init

Saat server start, engine harus memastikan struktur home sudah ada:

- `~/.fencode/data/chat-sessions.json`
- `~/.fencode/workspace/`
- `~/.fencode/skills/`
- `~/.fencode/config.json`

Tujuannya supaya state session/chat/config/skills tetap konsisten lintas restart dan tidak bergantung pada folder project runtime.

## Seed Bootstrap

Server boleh punya seed lokal di workspace:

- default: `fcode-server/seed/fencode`
- override env: `FENCODE_SEED_DIR`

Saat init, server hydrate file yang belum ada di `~/.fencode` dari seed tersebut.
Aturan hydrate: hanya copy file yang belum ada, tidak overwrite file user yang sudah eksis.

## Web UI Local DB Alignment

Untuk mode hybrid saat ini, `web-ui` local DB juga harus diarahkan ke home engine:

- dari: `web-ui/data/fcode-v2-db.json`
- ke: `~/.fencode/data/fcode-v2-db.json`

Jika file lama masih ada dan file baru belum ada, lakukan migrasi otomatis sekali saat init.
