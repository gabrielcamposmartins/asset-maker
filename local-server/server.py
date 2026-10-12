"""Servidor local de modelos do Asset Maker.

Expõe por HTTP o que roda na sua máquina — Qwen3-TTS na GPU e a CLI do Claude Code
(`claude -p`) — para os nodes "locais" do editor. Inicie com start.ps1 ou:

    .venv\\Scripts\\python.exe server.py --models-dir D:\\modelos --port 8765
"""

import argparse
import os
import traceback
from pathlib import Path

import torch
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from backends import UserError
from backends.claude_cli import ClaudeCLIBackend, ClaudeRequest
from backends.qwen3_tts import Qwen3TTSBackend, TTSRequest, VoiceRequest
from model_cache import ModelCache

# Só páginas servidas do próprio computador podem chamar o servidor: ele usa a GPU e executa o
# Claude Code com o seu login — com CORS aberto, qualquer site visitado poderia fazer o mesmo.
LOCAL_ORIGIN_RE = r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$"


def pick_device(requested: str) -> str:
    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        major, minor = torch.cuda.get_device_capability(0)
        if f"sm_{major}{minor}" not in torch.cuda.get_arch_list():
            print(f"⚠ Este PyTorch ({torch.__version__}) não tem kernels para sm_{major}{minor} — "
                  f"reinstale com setup.ps1 usando um -Cuda mais novo.")
        return "cuda:0"
    print("⚠ CUDA indisponível — rodando na CPU (muito lento). Confira o driver NVIDIA e o PyTorch instalado.")
    return "cpu"


def guarded(fn, *args):
    """Converte erros inesperados em HTTPException, para que a resposta mantenha os cabeçalhos CORS."""
    try:
        return fn(*args)
    except (UserError, HTTPException):
        raise
    except torch.cuda.OutOfMemoryError as exc:
        raise HTTPException(507, "Memória de GPU insuficiente — feche outros programas que usam a GPU "
                                 "ou inicie o servidor com -MaxLoaded 1.") from exc
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(500, f"{type(exc).__name__}: {exc}") from exc


def create_app(models_dir: Path, max_loaded: int, device: str, extra_origins: list[str] | None = None) -> FastAPI:
    cache = ModelCache(max_loaded)
    tts = Qwen3TTSBackend(models_dir, cache, device)
    claude = ClaudeCLIBackend()

    app = FastAPI(title="Asset Maker — servidor local", version="1.1")
    app.add_middleware(CORSMiddleware, allow_origins=extra_origins or [], allow_origin_regex=LOCAL_ORIGIN_RE,
                       allow_methods=["*"], allow_headers=["*"])

    @app.middleware("http")
    async def allow_private_network(request: Request, call_next):
        # Chrome (Private Network Access) pede esse cabeçalho no preflight para acessar localhost
        response = await call_next(request)
        if request.headers.get("access-control-request-private-network"):
            response.headers["Access-Control-Allow-Private-Network"] = "true"
        return response

    @app.exception_handler(UserError)
    async def user_error(_request: Request, exc: UserError):
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    @app.get("/health")
    def health():
        gpu = None
        if device.startswith("cuda"):
            free, total = torch.cuda.mem_get_info(0)
            gpu = {"name": torch.cuda.get_device_name(0),
                   "vram_total_gb": round(total / 1024**3, 1), "vram_free_gb": round(free / 1024**3, 1)}
        return {"ok": True, "device": device, "gpu": gpu, "torch": torch.__version__,
                "models_dir": str(models_dir), "max_loaded": cache.max_loaded, "loaded": cache.loaded(),
                "backends": {"qwen3-tts": tts.info(), "claude": claude.info()}}

    @app.post("/unload")
    def unload():
        return {"unloaded": cache.unload()}

    @app.post("/shutdown")
    def shutdown(request: Request):
        """Desliga o servidor (botão Desligar em Chaves), liberando a VRAM antes de sair."""
        server = getattr(request.app.state, "uvicorn_server", None)
        if server is None:
            raise HTTPException(501, "Servidor iniciado sem suporte a desligamento remoto.")
        cache.unload()
        server.should_exit = True
        return {"ok": True}

    # ---------- Qwen3-TTS ----------

    @app.get("/qwen3-tts/info")
    def qwen_info():
        return tts.info()

    @app.get("/qwen3-tts/voices")
    def list_voices():
        return {"voices": tts.list_voices()}

    @app.post("/qwen3-tts/voices")
    def create_voice(req: VoiceRequest):
        return guarded(tts.create_voice, req)

    @app.delete("/qwen3-tts/voices/{name}")
    def delete_voice(name: str):
        return guarded(tts.delete_voice, name)

    @app.get("/qwen3-tts/voices/{name}/audio")
    def voice_audio(name: str):
        return FileResponse(guarded(tts.reference_path, name), media_type="audio/wav")

    @app.post("/qwen3-tts/tts")
    def synthesize(req: TTSRequest):
        return guarded(tts.synthesize, req)

    # ---------- Claude Code (claude -p) ----------

    @app.get("/claude/info")
    def claude_info():
        return claude.info()

    @app.post("/claude/run")
    def claude_run(req: ClaudeRequest):
        return guarded(claude.run, req)

    return app


def main():
    parser = argparse.ArgumentParser(description="Servidor local de modelos do Asset Maker")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--models-dir", default=os.environ.get("ASSETS_MODELS_DIR", r"D:\modelos"))
    parser.add_argument("--max-loaded", type=int, default=2, help="modelos mantidos na GPU ao mesmo tempo")
    parser.add_argument("--device", default="auto", help="auto | cuda:0 | cpu")
    parser.add_argument("--allow-origin", action="append", default=[],
                        help="origem extra autorizada além de localhost (ex.: http://meu-pc.local:8741)")
    args = parser.parse_args()

    models_dir = Path(args.models_dir)
    device = pick_device(args.device)
    app = create_app(models_dir, args.max_loaded, device, args.allow_origin)
    print(f"\n  Asset Maker — servidor local\n"
          f"  URL:     http://{args.host}:{args.port}\n"
          f"  Modelos: {models_dir}\n"
          f"  Device:  {device}" + (f" ({torch.cuda.get_device_name(0)})" if device.startswith("cuda") else "") + "\n")
    # uvicorn.Server (em vez de uvicorn.run) para a rota /shutdown conseguir encerrar o processo
    server = uvicorn.Server(uvicorn.Config(app, host=args.host, port=args.port, log_level="info",
                                          timeout_graceful_shutdown=5))
    app.state.uvicorn_server = server
    server.run()


if __name__ == "__main__":
    main()
