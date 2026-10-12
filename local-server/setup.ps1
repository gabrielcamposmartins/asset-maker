<#
  Cria o ambiente Python do servidor local (.venv) com PyTorch CUDA + qwen-tts.

  Uso:
    powershell -ExecutionPolicy Bypass -File local-server\setup.ps1
    powershell -ExecutionPolicy Bypass -File local-server\setup.ps1 -Cuda cu126   # GPUs mais antigas / drivers antigos
#>
param(
  [string]$Cuda = "cu128",   # RTX 50xx (Blackwell) exige cu128 ou mais novo
  [string]$Python = "3.12"
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Invoke-Step([string]$Message, [scriptblock]$Command) {
  Write-Host "==> $Message" -ForegroundColor Cyan
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Message falhou (código $LASTEXITCODE)" }
}

$venvPy = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
$torchIndex = "https://download.pytorch.org/whl/$Cuda"
$useUv = [bool](Get-Command uv -ErrorAction SilentlyContinue)

if (-not (Test-Path $venvPy)) {
  if ($useUv) {
    Invoke-Step "Criando .venv (Python $Python) com uv" { uv venv --python $Python .venv }
  } else {
    Invoke-Step "Criando .venv (Python $Python) com venv" { py "-$Python" -m venv .venv }
    Invoke-Step "Atualizando pip" { & $venvPy -m pip install --upgrade pip }
  }
}

if ($useUv) {
  Invoke-Step "Instalando PyTorch ($Cuda)" { uv pip install --python $venvPy torch torchaudio --index-url $torchIndex }
  Invoke-Step "Instalando qwen-tts e o servidor" { uv pip install --python $venvPy -r requirements.txt }
} else {
  Invoke-Step "Instalando PyTorch ($Cuda)" { & $venvPy -m pip install torch torchaudio --index-url $torchIndex }
  Invoke-Step "Instalando qwen-tts e o servidor" { & $venvPy -m pip install -r requirements.txt }
}

Invoke-Step "Verificando a GPU" {
  & $venvPy -c "import torch; ok = torch.cuda.is_available(); print('torch', torch.__version__, '| CUDA:', ok, '|', torch.cuda.get_device_name(0) if ok else 'sem GPU - vai rodar na CPU (lento)')"
}
Write-Host "`nPronto. Baixe os modelos com local-server\download-models.ps1 e inicie com local-server\start.ps1" -ForegroundColor Green
