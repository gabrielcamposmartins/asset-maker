<#
  Inicia o servidor local de modelos (padrão: http://127.0.0.1:8765).

  Uso:
    powershell -ExecutionPolicy Bypass -File local-server\start.ps1
    powershell -ExecutionPolicy Bypass -File local-server\start.ps1 -MaxLoaded 1   # pouca VRAM
#>
param(
  [string]$ModelsDir = "D:\modelos",
  [int]$Port = 8765,
  [int]$MaxLoaded = 2,              # quantos modelos ficam na GPU ao mesmo tempo
  [string]$BindHost = "127.0.0.1"
)
$ErrorActionPreference = "Stop"
$py = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
  throw "Ambiente não encontrado — rode antes: powershell -ExecutionPolicy Bypass -File local-server\setup.ps1"
}
& $py (Join-Path $PSScriptRoot "server.py") --models-dir $ModelsDir --port $Port --max-loaded $MaxLoaded --host $BindHost
