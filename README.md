# FenCode

FenCode is a local coding agent runtime with:
- App Server (default `32188`)
- Web UI (default `25874`)
- One CLI launcher: `fencode`

This package is published as [`@aiden2209/fencode`](https://www.npmjs.com/package/@aiden2209/fencode).

## Install

```bash
npm i -g @aiden2209/fencode
```

## Quick Start

```bash
fencode start
fencode status
```

Open Web UI at `http://localhost:25874`.

## CLI Commands

```bash
fencode start [--ap <port>] [--ui <port>]
fencode stop
fencode restart [--ap <port>] [--ui <port>]
fencode status
fencode logs [--tail <lines>]
fencode check
fencode autostart --true
fencode autostart --false
fencode version
fencode --version
fencode -v
fencode help
```

Defaults:
- `--ap 32188`
- `--ui 25874`

## Auth Modes (Important)

FenCode supports two authentication modes:

### 1) OAuth Mode
- Uses OAuth tokens from FenCode auth file.
- Intended for OpenAI ChatGPT/Codex account flow.
- Runtime uses OAuth token (`tokens.access_token`) and Codex-compatible backend behavior.
- Provider base URL is treated as managed/locked by OAuth flow in settings.

### 2) API Key Mode
- Uses `OPENAI_API_KEY`.
- Supports custom OpenAI-compatible base URLs.
- Best for custom provider/router setups.

### Auth File Location

FenCode reads/writes auth in active FenCode home:
- Dev/source runtime: `~/.fencode-dev/auth.json`
- Installed/npm runtime: `~/.fencode/auth.json`
- If `FENCODE_HOME` is set, that path is used instead.

### OAuth Import

You can import existing OAuth data from `~/.codex/auth.json` from Settings, but it is optional.
FenCode runtime still uses its own active auth file.

## Storage Paths

Default home directory:
- Dev/source checkout: `~/.fencode-dev`
- Installed/npm package: `~/.fencode`

Inside home:
- `config.json` (runtime config)
- `auth.json` (auth state)
- `data/` (DB/state)
- `runtime/` (launcher state + logs)

## Update

Check updates:

```bash
fencode check
```

Upgrade:

```bash
npm i -g @aiden2209/fencode@latest
```

## Windows Autostart

Enable:

```bash
fencode autostart --true
```

Disable:

```bash
fencode autostart --false
```

This writes/removes:
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\FenCode`

## Notes

- `fencode start` runs a hidden supervisor process.
- Supervisor manages app server + web UI child processes.
- Runtime state file:
  - `.../runtime/launcher-state.json`
- Logs:
  - `.../runtime/app-server.out.log`
  - `.../runtime/web-ui.out.log`
