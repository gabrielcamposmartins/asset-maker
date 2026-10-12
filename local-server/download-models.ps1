<#
  Baixa os modelos Qwen3-TTS do Hugging Face para <ModelsDir>\qwen3-tts\<repo>.
  Cada repo já inclui o speech tokenizer (subpasta speech_tokenizer) — não é preciso baixá-lo à parte.
  Downloads interrompidos são retomados ao rodar de novo.

  Uso:
    powershell -ExecutionPolicy Bypass -File local-server\download-models.ps1
    powershell -ExecutionPolicy Bypass -File local-server\download-models.ps1 -Small       # + variantes 0.6B
    powershell -ExecutionPolicy Bypass -File local-server\download-models.ps1 -ModelsDir E:\ia
#>
param(
  [string]$ModelsDir = "D:\modelos",
  [switch]$Small   # também baixa Base 0.6B e CustomVoice 0.6B (menos VRAM, qualidade menor)
)
$ErrorActionPreference = "Stop"

$dest = Join-Path $ModelsDir "qwen3-tts"
New-Item -ItemType Directory -Force $dest | Out-Null

$repos = @(
  "Qwen3-TTS-12Hz-1.7B-Base",          # clonagem de voz (perfis de voz)       ~4.5 GB
  "Qwen3-TTS-12Hz-1.7B-CustomVoice",   # 9 speakers pré-definidos + estilo     ~4.5 GB
  "Qwen3-TTS-12Hz-1.7B-VoiceDesign"    # cria vozes a partir de descrição      ~4.5 GB
)
if ($Small) { $repos += "Qwen3-TTS-12Hz-0.6B-Base", "Qwen3-TTS-12Hz-0.6B-CustomVoice" }

$hf = Join-Path $PSScriptRoot ".venv\Scripts\hf.exe"
foreach ($r in $repos) {
  $target = Join-Path $dest $r
  Write-Host "==> Qwen/$r -> $target" -ForegroundColor Cyan
  if (Test-Path $hf) {
    & $hf download "Qwen/$r" --local-dir $target
  } else {
    uvx --from "huggingface_hub[hf_xet]" hf download "Qwen/$r" --local-dir $target
  }
  if ($LASTEXITCODE -ne 0) { throw "Falha ao baixar Qwen/$r (código $LASTEXITCODE)" }
}
Write-Host "`nModelos em $dest" -ForegroundColor Green
