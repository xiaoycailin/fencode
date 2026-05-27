# FCode Server Agent Loop (Node/TS)

Status: foundation implemented for Codex-like lifecycle events.

## Legacy Alignment Checklist
- `[done]` 1. Samakan kontrak event lama vs baru (`cmd/tool/file/thinking/session`) termasuk payload key penting.
- `[done]` 2. Tambah compatibility adapter layer untuk shape lama.
- `[done]` 3. Samakan format config/auth/workspace store dengan ekosistem `fcode` lama.
- `[done]` 4. Samakan permission, sandbox policy, interrupt, timeout, retry default.
- `[done]` 5. Samakan error taxonomy lama.
- `[done]` 6. Port golden test scenario dari `fcode` lama.

## Compatibility Layer
- `web-ui/src/lib/fcodeServerCompat.ts` jadi adapter shape server baru -> shape event/session yang dipakai UI lama.
- `web-ui/src/lib/fcodeServerProxy.ts` sekarang normalize JSON dan SSE event sebelum masuk ke UI.

## Config Store Alignment
- `fcode-server/src/store.ts` sekarang normalize `~/.fencode/config.json` ke shape lama:
  - `modelProvider`
  - `provider`
  - `engineServerUrl`
  - `projects[]`
  - `features.memories`
  - `storage`
- Workspace default server sekarang ikut `projects[0]` bila ada, baru fallback ke workspace internal.

## Runtime Policy Alignment
- `src/runtime/runtimePolicy.ts` jadi source default untuk timeout, retry, sandbox name, dan interrupt message.
- Provider request retry sekali setelah fallback kosong/gagal.
- Command timeout default `45s`, mirip flow lama yang cepat fail dan bisa retry.
- Permission summary dikirim ke model dalam runtime instructions.
- Interrupt message distandarkan: `Stopped by user`.
- Command berisiko di `full-access` sekarang pakai interactive approval gate:
  - status sesi pindah ke `waiting-approval`
  - event `approval.requested`
  - lanjut hanya setelah approval `approved` / `rejected`
- Preflight sekarang 3 level:
  - `none`: smalltalk/greeting (`hai`, `ok`, `thanks`, `next`) -> tanpa `workspace.scan` dan `git status`
  - `light`: intent cek konteks/workspace/file -> `workspace.scan` saja
  - `full`: intent coding/edit/build/test -> `workspace.scan` + `git status`

## Event Contract Alignment
- Payload key penting sekarang konsisten dengan pola lama:
  - `cmd.start`: `command`, `shell`, `cwd`, `pid`
  - `cmd.done`: `pid`, `exitCode`, `duration`, `fullOutput`, `expandable`, `error?`
  - `tool.done`: `tool`, `output`, `status`, `duration`
  - `tool.error`: `tool`, `status`, `message`, `error{code,message,hint}`
  - `approval.requested`: `type`, `command`, `reason`, `hint`, `status=waiting`
  - `approval.resolved`: `type`, `command`, `decision`, `status`
  - `file.edit`: `path`, `diff`, `hunks`, `additions`, `deletions`, `expandable`
  - `thinking.*` / `session.*`: `message`

## Error Taxonomy Alignment
- Error server sekarang pakai shape konsisten:
  - `{ error: { code, message, hint? } }`
- Kode utama:
  - `session_not_found`
  - `session_busy`
  - `bad_request`
  - `not_found`
  - `internal_error`
  - `permission_denied`
  - `dangerous_command`
  - `command_not_allowed`
  - `patch_anchor_not_found`
  - `invalid_patch`
- Proxy web-ui juga normalize error string lama ke object error taxonomy yang sama.

## Golden Smoke Test
- `npm.cmd run test:golden` di `fcode-server` menjalankan smoke test mandiri:
  - create session -> send messages -> answer referential context
  - command tool emits `cmd.start` dan `cmd.done`
  - missing session returns taxonomy error `session_not_found`
- Test pakai mock provider lokal, jadi tidak butuh API eksternal.

## Session Context
- Runtime sekarang menerima:
  - history message sesi terakhir
  - recent activity/event sesi terakhir
  - runtime notes saat run mulai
  - memory context dari `~/.fencode/memories` kalau `features.memories=true`
- Tujuan utama: pertanyaan referensial seperti "aku tadi tanya apa ya?" atau follow-up ambigu tetap punya konteks percakapan dan aktivitas terakhir, bukan jawab dari pesan tunggal.

## Personalization And Memory
- `personality` di `~/.fencode/config.json` sekarang masuk ke runtime instructions:
  - `pragmatic`: singkat, direct, task-focused
  - `friendly`: hangat dan kolaboratif
  - `creative`: eksploratif dan idea-forward
- Runtime prompt juga mengirim metadata identitas agent secara eksplisit:
  - `FCode Agent`
  - runtime backend `fcode-server (Node/TypeScript)`
  - active model
  - provider wire API
  - workspace root
  - permission mode
  - global scan status
- `reasoningEffort` ikut dikirim sebagai preference text.
- `features.memories=true` membuat runtime membaca file `.md`, `.txt`, `.jsonl` dari `~/.fencode/memories`.
- Folder `.git` di memories diabaikan.
- Memory saat ini dibaca sebagai context injection; write/consolidation rollout belum otomatis.

## Auth Mode Policy
- Mode auth sekarang dipisah jelas:
  - `oauth`: provider base URL default dipaksa ke `https://chatgpt.com/backend-api/codex`, token dari `tokens.access_token`
  - `api-key`: provider base URL boleh custom (contoh 9router / OpenAI-compatible), token dari `OPENAI_API_KEY`
- Runtime `fcode-server` baca auth utama dari `~/.fencode/auth.json`.
- Untuk mode `oauth`, runtime sengaja mengabaikan `auth.openai_base_url` / `auth.base_url` agar tidak salah route ke `https://api.openai.com/v1` (penyebab scope `api.responses.write` 401 di flow ChatGPT account).
- Provider failure sekarang mempertahankan gabungan error asli dari `/responses` dan `/chat/completions` setelah fallback/retry, bukan ditimpa error generik atau error fallback terakhir saja.
- Saat user pilih OAuth di UI:
  1. coba pakai token OAuth yang sudah ada di `~/.fencode/auth.json`
  2. jika tidak ada, user bisa pilih OAuth callback flow atau device flow:
     - callback flow membuka `https://auth.openai.com/oauth/authorize...`
     - callback listener lokal menerima redirect di `http://localhost:1455/auth/callback`
     - callback flow exchange authorization code ke `https://auth.openai.com/oauth/token`
     - device flow tetap tersedia sebagai mode opsional:
     - request user code ke `https://auth.openai.com/api/accounts/deviceauth/usercode`
     - user verifikasi di `https://auth.openai.com/codex/device`
     - poll code ke `.../deviceauth/token`
     - exchange authorization code ke `https://auth.openai.com/oauth/token`
     - simpan token akhir ke `~/.fencode/auth.json`
- Import token dari `~/.codex/auth.json` tetap tersedia, tapi manual/opsional lewat action `oauth-import-codex`; runtime tetap hanya membaca `~/.fencode/auth.json`.
- Login page sekarang auto-poll device flow per `interval` detik sambil tetap menyediakan tombol cek manual.
- Settings > Config mengunci `provider.baseUrl` ke `https://api.openai.com/v1` saat auth mode `oauth`.
- Settings > Config juga mengunci `provider.wireApi` saat auth mode `oauth`.
- Runtime `fcode-server` mencoba refresh OAuth access token otomatis bila token hampir expired dan `refresh_token` tersedia.
- Refresh failure dibatasi minimal 60 detik antar-attempt dan status error terakhir dicatat di `auth.json`.
- Jika provider balas `401/403`, runtime mencoba force-refresh OAuth token sekali lalu retry request.
- Request provider sekarang kirim header compat tambahan:
  - `x-client-request-id` (UUID per request)
  - `x-codex-window-id` (default `1`, bisa override env `FCODE_WINDOW_ID`)
  - `ChatGPT-Account-ID` jika `tokens.account_id` tersedia
- Request `/responses` mode OAuth mengirim `store:false` dan `stream:true`, sesuai kontrak backend Codex.
- Runtime membaca respons SSE `responses` dan mengekstrak `response.output_text.delta` / completed output menjadi teks final.
- Mode OAuth tidak fallback ke `/chat/completions`; backend Codex lama memakai `/responses` dan `/chat/completions` bisa balas HTML/403.
- Chat UI menampilkan badge auth ringkas (`OAuth` / `API Key`) dan indikator refresh gagal.
- Settings > Auth sekarang punya:
  - detail akun OAuth dari token lokal: email, name, plan type, dan jenis akun personal/workspace-business
  - `Retry refresh` untuk paksa refresh token OAuth manual
  - `Re-login OAuth` untuk restart device flow langsung dari halaman auth
  - tombol `Open verification URL`, `Copy code`, dan auto-poll sampai OAuth selesai

## Runtime Layout
- `src/agentRuntime.ts`
  - orchestration loop only
  - provider call
  - transcript assembly
- `src/runtime/toolProtocol.ts`
  - strict tool JSON contract
  - parser for model output
- `src/runtime/toolExecutor.ts`
  - execute runtime tools
  - preflight signal collection
- `src/runtime/commandSafety.ts`
  - command guard per permission mode
  - dangerous command blocklist
- `src/workspace.ts`
  - workspace fs helpers
  - text patch and structured patch helper
  - file listing and text search helper

## Runtime Flow
1. `thinking.start` + context (`workspace`, `permission`)
2. preflight:
   - `tool.start/tool.done` `workspace.scan`
   - `cmd.start/cmd.done` `git status --porcelain=v1`
3. iterative loop (max 10 steps):
   - provider returns one JSON action:
     - `run_command`
     - `read_file`
     - `write_file`
     - `apply_patch`
     - `list_files`
     - `search_files`
     - `final`
   - server executes action and emits events
4. finish with `message.done` + `session.done` (or `session.error`)

## Goal Continuation Guard
- Meniru pola `codex-rs` active-goal lifecycle dalam bentuk ringan:
  - runtime menetapkan `Active objective` dari pesan user
  - objective implementasi (`buatkan`, `create`, `fix`, `edit`, dll) tidak boleh `final` sebelum ada aksi nyata
  - `final` diblok bila:
    - masih pakai wording defer seperti `kalau mau next aku lanjut`
    - hanya memberi recipe command tanpa command dijalankan
    - user minta implementasi tapi belum ada `write_file` / `apply_patch` / `run_command`
- Tujuan utama: agent lanjut kerja sampai objective selesai, bukan stop di template jawaban pertama.
- Session sekarang menyimpan `activeGoalObjective`:
  - saat user memberi task implementasi, objective aktif disimpan di session
  - saat user hanya kirim `next` / `lanjut` / `continue` / `gas`, runtime otomatis melanjutkan objective aktif
  - objective dibersihkan saat run sukses dan sudah ada command/write action nyata
- Objective `scaffold/create` sekarang lebih ketat:
  - tidak boleh final hanya setelah 1 command scaffold
  - harus ada progress lanjutan (create/install/edit), dan minimal ada perubahan file
  - jika step habis sebelum lengkap, fallback message menandai objective belum selesai (active goal tetap lanjut di turn `next`)

## Persistent Command Lifecycle
- `run_command` sekarang klasifikasi command persisten/watch:
  - command dev umum (`npm run dev`, `vite`, `next dev`, dll) dijalankan mode `until-ready`
  - saat output readiness terdeteksi (mis. `VITE ... ready`, `Local: http://...`), proses dihentikan otomatis lalu dianggap sukses agar agent loop tidak nyangkut
  - watcher tanpa readiness signal jelas (`--watch`, `tail -f`, dll) ditolak di foreground dengan error terarah
- Tujuan: hindari run menggantung di terminal dan jaga agent tetap lanjut workflow berikutnya.

## Run Watchdog
- Ada watchdog timeout global per run (`AGENT_RUN_TIMEOUT_MS`, default `30m`).
- Jika run tidak selesai, server auto-abort run, emit `session.error` + `session.done`, lalu paksa status session kembali `idle`.
- Ada cleanup fail-safe: jika fungsi runtime keluar tapi status masih `streaming`, server tetap memulihkan ke `idle`.
- Timeout provider per request juga dinaikkan (`PROVIDER_TIMEOUT_MS`, default `180s`) supaya task panjang, refactor besar, atau reasoning lambat tidak cepat putus padahal run utama masih valid.

## Executable Skills
- Mode proxy `fcode-server` sekarang menangani executable skill `imagegen` sendiri, tidak lagi fallback ke jawaban teks biasa.
- Trigger baca `input[]` item `type:"skill"` dengan id yang cocok:
  - `system/imagegen`
  - `skills/imagegen`
  - `imagegen`
- Hardening fallback:
  - kalau UI gagal mengirim `input` skill, server tetap treat pesan sebagai imagegen bila konten berisi mention skill `fcode-mention://skill/...`, prefix `[Imagegen]`, atau token `@Imagegen`
  - route web-ui `/api/sessions/:id/messages` juga auto-sisip `input.type="skill"` untuk pola mention imagegen yang sama sebelum request diproxy
- Runtime imagegen:
  - baca provider aktif dari `~/.fencode/config.json` + `~/.fencode/auth.json`
  - pakai endpoint provider aktif `POST {baseUrl}/images/generations`
  - baca model selector UI dari `~/.fencode/data/fcode-v2-db.json` (`imageGenSettings.selectedModel`)
  - fallback model default `cx/gpt-5.5-image`
  - timeout guard 120s supaya session tidak nyangkut `streaming` bila provider lambat/hang
  - simpan hasil ke `<workspace>/artifacts/FCode Image ...`
  - emit event `tool.start`, `thinking.delta`, `file.create`, `tool.done`, `message.done`, `session.done`
- Tujuan: lifecycle skill tetap konsisten walau web UI jalan via proxy ke backend baru.

## Web UI Stream Resync
- `web-ui` sekarang tidak hanya mengandalkan SSE push.
- Hook stream menambah fallback `GET /api/sessions/:id/events?lastEventId=...` berkala untuk menarik event yang mungkin miss saat tab aktif.
- Jika SSE sunyi terlalu lama, client auto reconnect ringan sambil tetap menjaga `lastEventId`.
- Tujuan: update bubble/activity feed tetap masuk tanpa reload manual tab chat.

## Compact Meter

## Launcher CLI (`fencode`)
- Workspace root sekarang punya launcher `fencode` (Windows):
  - `fencode start [--ap <port>] [--ui <port>]`
- `fencode stop`
- `fencode status`
- `fencode logs [--tail <lines>]`
- `fencode restart [--ap <port>] [--ui <port>]`
- `fencode help`
- Default port:
  - app server (`--ap`): `32188`
  - web UI (`--ui`): `25874`
- Saat `start`, launcher:
  - start `fcode-server` + `web-ui` mode `npm run start`
  - Windows launcher sekarang pakai 1 hidden supervisor process yang menahan 2 child process (`app-server` + `web-ui`)
  - set env `FCODE_SERVER_PORT`, `FCODE_SERVER_HOST`, `FCODE_SERVER_BASE_URL`, `FCODE_BACKEND=server`
  - update `~/.fencode/config.json` field `engineServerUrl` sesuai port app server aktif
  - simpan PID + log path ke `~/.fencode/runtime/launcher-state.json`
- `fencode status` menampilkan status supervisor/app/ui + URL aktif + path log.
- `fencode logs` menampilkan tail log `app-server` dan `web-ui`.
- Supervisor sekarang menulis heartbeat ke `launcher-state.json` dan `launcher-children.json`; `status` membaca state itu lalu fallback ke port listener check.
- Untuk npm publish, root `package.json` pakai `files` whitelist supaya tarball tidak ikut membawa `.next`, artifacts, runtime logs, dan temp output.
- Build web UI production sekarang pakai `output: "standalone"` juga di Windows (non-dev), supaya launcher npm bisa jalan tanpa `web-ui/node_modules/next` source tree.
- `npm run build` root sekarang:
  - build `fcode-server/dist`
  - build `web-ui/.next-v2/standalone`
  - set `FENCODE_HOME` dan `CODEX_HOME` sementara ke folder `.tmp-*` lokal saat build UI agar Next file tracing tidak mengemas data user dari home directory
  - copy `web-ui/.next-v2/static` + `web-ui/public` ke folder standalone untuk runtime asset.
- `prepack` sekarang hanya menjalankan `fencode-prepare-package.js` (tanpa rebuild) untuk menghindari potensi hang `next build` saat `npm pack/publish`.
- Konsekuensi: sebelum `npm publish`, jalankan `npm run build` manual dulu.
- `resolveRepoRoot()` mendukung dua layout:
  - source checkout (`fcode-server/package.json` + `web-ui/package.json`)
  - npm runtime package (`runtime/fcode-server/dist/index.js` + `web-ui/.next-v2/standalone/server.js`)
- `fencode-prepare-package.js` sekarang menyalin `fcode-server/dist` ke `runtime/fcode-server/dist` agar `fencode start` global tidak tergantung source tree.
- Web UI server-side fallback path tidak lagi memakai `os.homedir()` saat build; fallback relative `.fencode/.codex` mencegah Next file tracing menyalin data user home dan menghilangkan warning trace absolut Windows.
- Launcher `start` sekarang selalu inject `FENCODE_HOME` ke hidden supervisor; app server dan web UI standalone menulis/membaca `auth.json`, `config.json`, DB, dan runtime state dari home yang sama. Ini memperbaiki OAuth login npm-global yang sebelumnya bisa tersimpan ke path relative `.fencode` milik package, sementara server membaca `C:\Users\<user>\.fencode`.
- Settings > Config toggle `Enable memories` dan `Allow global scan` sekarang auto-save saat diklik, bukan hanya mengubah local React state. Reload halaman harus mempertahankan nilai dari `~/.fencode/config.json`.
- Shim global opsional:
  - `C:\Users\ADMIN\bin\fencode.cmd` bisa dipakai sebagai shim global ke repo launcher
  - folder `C:\Users\ADMIN\bin` perlu ada di user `PATH`
  - terminal yang sudah terbuka sebelum update `PATH` perlu dibuka ulang dulu
- Meter token di chat UI sekarang menghitung context aktif setelah marker compact terakhir.
- Setelah `Context compacted`, estimasi `% full` tidak lagi menjumlah seluruh histori lama sesi.
- Tujuan: angka compact di UI turun sesuai persepsi user setelah compact manual.

## Global Scan Toggle
- `config.json` sekarang support `features.allowGlobalScan`.
- Toggle tampil di Settings > Config sebagai **Allow global scan**.
- Saat `false`:
  - browse/read API UI tetap terikat workspace aktif
  - command yang mengandung absolute path di luar workspace memicu `approval.requested` dulu
- Saat `true`:
  - read-only scan/read absolute path luar workspace diizinkan
- Write/delete tetap dibatasi ke workspace aktif.

## Approval Endpoint
- `POST /sessions/:id/approval`
- Body: `{ "decision": "approved" | "rejected" }`
- Response: `{ "ok": true, "decision": "...", "runId": "..." }`
- Jika tidak ada request approval pending: `409 bad_request`.

## Dev Trigger
- Pesan `/debug approval <command>` mem-bypass provider dan langsung membuat run debug dengan:
  - `session.status = waiting-approval`
  - event `approval.requested`
  - tombol UI approve/reject bisa dites deterministik

## Tool Notes
- `apply_patch` sekarang jadi edit default untuk perubahan kecil.
- `apply_patch` support exact search/replace dan block patch:

```txt
*** Replace
*** OLD
old text
*** NEW
new text
*** End Replace
```

- `write_file` tetap ada untuk full overwrite/create.
- `list_files` dan `search_files` ditambah supaya agent bisa bangun context sebelum edit.
- `list_files` sekarang menampilkan **folder dan file** (`[dir] ...`, `[file] ...`), bukan file-only.

## Command Safety
- `read-only`: semua command ditolak.
- `workspace-write`: hanya command umum/dev/read-only yang diizinkan.
- `full-access`: command boleh jalan, tapi pola berbahaya tetap diblok.
- Pola berbahaya awal: `format`, `diskpart`, shutdown/restart, recursive delete, destructive `rm/del/rmdir`.

## Error Payload
- `tool.error` dan error command sekarang pakai shape stabil:

```json
{
  "error": {
    "code": "patch_anchor_not_found",
    "message": "patch OLD text not found",
    "hint": "Read the latest file content, then retry with exact text."
  }
}
```

- `cmd.done` gagal bisa bawa `payload.error`.
- UI activity feed baca `error.code`, `error.message`, `error.hint`.

## Event Contract
- command:
  - `cmd.start` `{ pid, command, cwd, shell }`
  - `cmd.output` `{ pid, stream, chunk }`
  - `cmd.done` `{ pid, command, exitCode, duration, fullOutput }`
- file:
  - `tool.start` `file.read` / `file.write`
  - `tool.done` `file.read` / `file.write`
  - `file.edit` for write preview
- generic:
  - `thinking.*`
  - `message.delta`, `message.done`
  - `session.done`, `session.error`

## Current Limits
- provider must follow JSON action contract; parser already has fallback for multi-JSON response.
- command safety policy is still basic allow/block pattern, belum approval interaktif.
- browser E2E should validate UI rendering of `cmd/tool/file` cards per run.

## Launcher CLI
- `fencode start [--ap <port>] [--ui <port>]`
- `fencode stop`
- `fencode restart [--ap <port>] [--ui <port>]`
- `fencode status`
- `fencode logs [--tail <lines>]`
- `fencode version` / `fencode --version` / `fencode -v`
- `fencode check`
  - cek versi package saat ini vs npm registry
  - jika ada update, output command upgrade global
- `fencode update`
  - stop app/web UI yang sedang running
  - jalankan `npm i -g @aiden2209/fencode@latest`
  - start ulang app/web UI dengan port lama/default
  - output versi lama -> baru, URL app/web, dan path logs
- `fencode autostart --true|--false`
  - Windows only
  - menulis `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\FenCode`
  - target command: `fencode.cmd start`

## UI Version Surface
- Settings > Config sekarang menampilkan:
  - package name
  - current version
  - update availability
  - command update global
  - tombol `Update now`
- Endpoint:
  - `GET /api/settings/version`
  - `POST /api/settings/version`
- `POST` menjalankan `fencode update` lewat launcher detached jika package root ditemukan.
- UI setelah klik `Update now`:
  - menampilkan indikator `Updating...`
  - polling `GET /api/settings/version` tiap 5 detik
  - ignore fetch error karena app/web server normalnya mati sebentar saat update
  - reload halaman saat versi aktif sudah match target/latest
- Fallback `POST` tetap menjalankan `npm i -g @aiden2209/fencode@latest` dari server host jika launcher tidak ditemukan.
- Pada Windows, npm subprocess harus lewat `cmd.exe /c npm ...`, bukan `spawnSync("npm.cmd")`, untuk hindari error `EINVAL` dari Node runtime.

## Home Directory Resolution
- default runtime home sekarang beda untuk dev vs install:
  - source/dev checkout: `~/.fencode-dev`
  - installed/package runtime: `~/.fencode`
- `FENCODE_HOME` tetap override tertinggi untuk semua mode.
- source/dev dideteksi dari layout repo (`bin/fencode.js`, `fcode-server/src`, `web-ui/src`).
- Tujuan:
  - dev tidak mencampur auth/config/db dengan install global
  - prod/npm tetap stabil di `~/.fencode`
- Catatan packaging Next standalone:
  - resolver home di `web-ui/src/lib/runtimeHome.ts` default ke path relatif (`.fencode-dev` / `.fencode`) saat `FENCODE_HOME` tidak ada.
  - ini mencegah output tracing `.next-v2` menarik path absolut user home (`C:\Users\...\ .fencode`) ke bundle standalone dan mencegah warning copy trace saat build.
