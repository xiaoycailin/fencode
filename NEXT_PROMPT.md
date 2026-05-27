# Prompt Lanjutan: FCode Server/Otak Baru

Konteks:
- Workspace baru: `D:\1coding-agent-engine`
- Source yang sudah disalin: `D:\1coding-agent-engine\web-ui`
- Ini salinan bersih dari `D:\1aiagent-coding\codex-rs\web-ui-v2`, tapi folder baru memakai nama `web-ui`
- Folder berat tidak ikut disalin: `node_modules`, `.next-v2`, `.next-v2-dev`, `data`

Tujuan produk:
- Bangun sistem baru bernama sementara `fcode-server` / coding agent engine.
- Server ini harus benar-benar mandiri, bukan berjalan "di bawah" `fcode.exe app-server`.
- Web UI harus connect ke server baru ini langsung.
- `fcode` CLI boleh tetap ada sebagai client/opsional, tapi bukan pusat lifecycle.

Arsitektur target:
- `fcode-server` menjadi proses utama:
  - expose HTTP/WebSocket API untuk web-ui
  - manage sessions, messages, tool events, terminal events, file operations
  - menjalankan agent loop sendiri atau via engine library reusable
  - punya start/restart/status/stop lifecycle sendiri
- `web-ui` menjadi client murni:
  - tidak spawn app-server lama
  - tidak bergantung ke `fcode.exe app-server`
  - semua komunikasi lewat endpoint server baru
- Tray/installer Windows nanti mengontrol:
  - `fcode-server`
  - web-ui runtime
  - optional CLI shortcut

Strategi implementasi disarankan:
1. Jangan bongkar UI besar dulu.
2. Map semua dependency web-ui yang sekarang bicara ke app-server:
   - `src/lib/appServerBridge.ts`
   - route API di `src/app/api/**`
   - session/chat/event stream flow
3. Definisikan API minimal server baru:
   - `GET /health`
   - `GET /sessions`
   - `POST /sessions`
   - `GET /sessions/:id/events`
   - `POST /sessions/:id/messages`
   - `POST /sessions/:id/interrupt`
   - `GET /workspace/tree`
   - `GET /git/status`
4. Buat adapter client baru di web-ui:
   - contoh nama: `src/lib/fcodeServerClient.ts`
   - bridge lama jangan dihapus sampai fitur parity cukup.
5. Server awal boleh wrapper/compat dulu:
   - target: UI hidup tanpa menjalankan `fcode.exe app-server`
   - engine internal bisa bertahap dipisah setelah API stabil.

Keputusan penting:
- Fokus Windows dulu.
- Installer akhir harus all-in-one.
- User tidak boleh wajib install Node/Rust.
- Kalau web-ui tetap Next standalone, bundle `node.exe` ke installer.
- Long-term lebih clean kalau server native juga serve UI/static atau bundle runtime sendiri.

Catatan dari thread sebelumnya:
- Build GitHub `windows-arm64` timeout 1h30m; rilis awal fokus `windows-x64`.
- Rust build cache bisa besar puluhan GB. Jangan taruh build target di workspace kecil.
- Local build target yang diinginkan: `C:\.fcode-build-target`.
- Jangan matikan proses `node` global sembarangan karena port `20128` dipakai Codex.

Tugas pertama di workspace baru:
1. Inspect `web-ui` flow, terutama session/chat/app-server bridge.
2. Buat desain API server baru yang kompatibel dengan UI.
3. Implement adapter web-ui kecil supaya bisa switch dari app-server lama ke server baru via env/config.
4. Baru scaffold server engine minimal.
