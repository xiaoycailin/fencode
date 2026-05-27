param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ArgsList
)

$ErrorActionPreference = "Stop"

$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$FencodeHome = if ($env:FENCODE_HOME -and $env:FENCODE_HOME.Trim()) { $env:FENCODE_HOME } else { Join-Path $env:USERPROFILE ".fencode" }
$RuntimeDir = Join-Path $FencodeHome "runtime"
$StatePath = Join-Path $RuntimeDir "launcher-state.json"
$ConfigPath = Join-Path $FencodeHome "config.json"

function Ensure-Dirs {
  New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
  New-Item -ItemType Directory -Force -Path $FencodeHome | Out-Null
}

function Is-ProcessAlive([int]$ProcessIdValue) {
  if ($ProcessIdValue -le 0) { return $false }
  $proc = Get-Process -Id $ProcessIdValue -ErrorAction SilentlyContinue
  return $null -ne $proc
}

function Read-State {
  if (!(Test-Path $StatePath)) { return $null }
  try {
    return Get-Content -Path $StatePath -Raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Write-State($state) {
  Ensure-Dirs
  $state | ConvertTo-Json -Depth 8 | Set-Content -Path $StatePath -Encoding UTF8
}

function Remove-State {
  if (Test-Path $StatePath) {
    Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
  }
}

function Update-EngineServerUrl([int]$AppPort) {
  Ensure-Dirs
  $config = $null
  if (Test-Path $ConfigPath) {
    try {
      $config = Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json
    } catch {
      $config = $null
    }
  }
  if ($null -eq $config) {
    $config = [ordered]@{
      version = 1
      createdAt = (Get-Date).ToString("o")
      modelProvider = "9router"
      model = "gpt-5.5"
      personality = "pragmatic"
      reasoningEffort = "medium"
      instructions = ""
      features = @{ memories = $true; allowGlobalScan = $false }
      provider = @{ id = "9router"; name = "9Router"; baseUrl = "http://127.0.0.1:20128/v1"; wireApi = "responses" }
      engineServerUrl = "http://127.0.0.1:32188"
      subagentModel = ""
      projects = @()
    }
  }
  $config.engineServerUrl = "http://127.0.0.1:$AppPort"
  $config | ConvertTo-Json -Depth 12 | Set-Content -Path $ConfigPath -Encoding UTF8
}

function Parse-PortArg([string[]]$List, [string]$Key, [int]$DefaultValue) {
  for ($i = 0; $i -lt $List.Length; $i++) {
    if ($List[$i] -eq $Key) {
      if ($i + 1 -ge $List.Length) {
        throw "Missing value for $Key"
      }
      $value = 0
      if (-not [int]::TryParse($List[$i + 1], [ref]$value)) {
        throw "Invalid integer for ${Key}: $($List[$i + 1])"
      }
      return $value
    }
  }
  return $DefaultValue
}

function Start-Fencode([string[]]$List) {
  $appPort = Parse-PortArg $List "--ap" 32188
  $uiPort = Parse-PortArg $List "--ui" 25874
  Ensure-Dirs

  $state = Read-State
  if ($state -and (Is-ProcessAlive([int]$state.appPid) -or Is-ProcessAlive([int]$state.uiPid))) {
    Write-Host "fencode already running (appPid=$($state.appPid), uiPid=$($state.uiPid)). Use 'fencode restart' or 'fencode stop'."
    return
  }

  Update-EngineServerUrl -AppPort $appPort

  $appOut = Join-Path $RuntimeDir "app-server.out.log"
  $appErr = Join-Path $RuntimeDir "app-server.err.log"
  $uiOut = Join-Path $RuntimeDir "web-ui.out.log"
  $uiErr = Join-Path $RuntimeDir "web-ui.err.log"

  $appCmd = "set FCODE_SERVER_PORT=$appPort&& set FCODE_SERVER_HOST=127.0.0.1&& npm.cmd run start"
  $uiCmd = "set FCODE_SERVER_BASE_URL=http://127.0.0.1:$appPort&& set FCODE_BACKEND=server&& npm.cmd run start -- -p $uiPort -H 127.0.0.1"
  $appProc = Start-Process -FilePath "cmd.exe" -ArgumentList @("/d", "/s", "/c", $appCmd) -WorkingDirectory (Join-Path $ScriptRoot "fcode-server") -WindowStyle Hidden -PassThru -RedirectStandardOutput $appOut -RedirectStandardError $appErr
  $uiProc = Start-Process -FilePath "cmd.exe" -ArgumentList @("/d", "/s", "/c", $uiCmd) -WorkingDirectory (Join-Path $ScriptRoot "web-ui") -WindowStyle Hidden -PassThru -RedirectStandardOutput $uiOut -RedirectStandardError $uiErr

  Write-State @{
    startedAt = (Get-Date).ToString("o")
    appPort = $appPort
    uiPort = $uiPort
    appPid = $appProc.Id
    uiPid = $uiProc.Id
    logs = @{
      appOut = $appOut
      appErr = $appErr
      uiOut = $uiOut
      uiErr = $uiErr
    }
  }

  Write-Host "fencode started"
  Write-Host "app server: http://127.0.0.1:$appPort (pid=$($appProc.Id))"
  Write-Host "web ui    : http://127.0.0.1:$uiPort (pid=$($uiProc.Id))"
}

function Stop-Fencode {
  $state = Read-State
  if ($state) {
    foreach ($processId in @([int]$state.appPid, [int]$state.uiPid)) {
      if ($processId -gt 0 -and (Is-ProcessAlive $processId)) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
      }
    }
    foreach ($port in @([int]$state.appPort, [int]$state.uiPort)) {
      if ($port -gt 0) {
        $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($conn) {
          Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
        }
      }
    }
  }
  Remove-State
  Write-Host "fencode stopped"
}

function Restart-Fencode([string[]]$List) {
  Stop-Fencode
  Start-Sleep -Milliseconds 700
  Start-Fencode $List
}

function Show-Help {
  @"
fencode command launcher

Usage:
  fencode start [--ap <port>] [--ui <port>]
  fencode stop
  fencode restart [--ap <port>] [--ui <port>]
  fencode help

Defaults:
  --ap 32188
  --ui 25874
"@ | Write-Host
}

$command = if ($ArgsList.Length -gt 0) { $ArgsList[0].ToLowerInvariant() } else { "help" }
$rest = if ($ArgsList.Length -gt 1) { $ArgsList[1..($ArgsList.Length - 1)] } else { @() }

switch ($command) {
  "start" { Start-Fencode $rest; break }
  "stop" { Stop-Fencode; break }
  "restart" { Restart-Fencode $rest; break }
  "help" { Show-Help; break }
  default {
    Write-Host "Unknown command: $command"
    Show-Help
    exit 1
  }
}
