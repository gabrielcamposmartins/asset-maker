"""Backend Claude Code — usa a CLI `claude -p` instalada na máquina como gerador de texto.

- sem ferramentas (--tools ""), sem customizações (--safe-mode) e numa pasta vazia: o node
  gera texto, não mexe em arquivos nem carrega CLAUDE.md de projetos;
- saída estruturada opcional com --json-schema (vem validada em `structured_output`);
- usa o login que você já tem no Claude Code (assinatura ou API key).
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from pydantic import BaseModel, Field

from backends import UserError

DEFAULT_SYSTEM = ("Você é um gerador de texto dentro de um pipeline de criação de assets. "
                  "Responda diretamente ao pedido, sem preâmbulos nem comentários sobre o que vai fazer.")
MODEL_RE = re.compile(r"^[A-Za-z0-9._\-\[\]]{0,64}$")
MAX_ARG_CHARS = 20000  # acima disso o texto vai por arquivo (limite de linha de comando do Windows)
EFFORT_RE = re.compile(r"[a-z]{2,10}")
DEFAULT_EFFORTS = ["low", "medium", "high", "xhigh", "max"]


class ClaudeRequest(BaseModel):
    prompt: str
    system: str = ""
    model: str = ""  # vazio = modelo padrão configurado na sua CLI
    effort: str = ""  # validado contra os níveis que a CLI instalada aceita
    json_schema: dict | None = None
    timeout_s: int = Field(600, ge=10, le=3600)


class ClaudeCLIBackend:
    def __init__(self, executable: str | None = None):
        self.executable = executable or shutil.which("claude")
        self.workdir = Path(tempfile.gettempdir()) / "assets-pipeline-claude"
        self.workdir.mkdir(exist_ok=True)
        self._version: str | None = None
        self._efforts: list[str] | None = None

    @staticmethod
    def _env() -> dict:
        env = dict(os.environ)
        # se o servidor foi iniciado de dentro de uma sessão do Claude Code, a CLI recusaria rodar aninhada
        for key in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"):
            env.pop(key, None)
        return env

    def _read_efforts(self) -> list[str]:
        """Níveis de --effort aceitos pela CLI instalada, lidos do --help.

        O help mostra, por exemplo: "--effort <level>  Effort level ... (low, medium, high, xhigh, max)".
        """
        try:
            out = subprocess.run([self.executable, "--help"], capture_output=True, text=True,
                                 timeout=30, env=self._env())
        except (OSError, subprocess.SubprocessError):
            return []
        text = " ".join((out.stdout or "").split())
        start = text.find("--effort")
        if start < 0:
            return []
        match = re.search(r"\(([^)]*)\)", text[start:start + 300])
        if not match:
            return []
        levels = [lvl.strip() for lvl in match.group(1).split(",")]
        return [lvl for lvl in levels if EFFORT_RE.fullmatch(lvl)]

    def info(self) -> dict:
        if self.executable and self._version is None:
            try:
                out = subprocess.run([self.executable, "--version"], capture_output=True, text=True,
                                     timeout=30, env=self._env())
                self._version = out.stdout.strip()
            except (OSError, subprocess.SubprocessError):
                self._version = ""
        if self.executable and self._efforts is None:
            self._efforts = self._read_efforts() or DEFAULT_EFFORTS
        return {"available": bool(self.executable), "executable": self.executable, "version": self._version,
                "efforts": self._efforts or DEFAULT_EFFORTS}

    def run(self, req: ClaudeRequest) -> dict:
        if not self.executable:
            raise UserError("CLI `claude` não encontrada no PATH do servidor. Instale o Claude Code e faça "
                            "login rodando `claude` uma vez no terminal; depois reinicie o servidor local.")
        if not req.prompt.strip():
            raise UserError("Prompt vazio.")
        if not MODEL_RE.match(req.model):
            raise UserError(f"Modelo inválido: {req.model}")
        efforts = self._efforts or self.info().get("efforts") or DEFAULT_EFFORTS
        if req.effort and req.effort not in efforts:
            raise UserError(f"Esforço inválido: {req.effort}. Aceitos pela sua CLI: {', '.join(efforts)}.")

        system = req.system.strip() or DEFAULT_SYSTEM
        cmd = [self.executable, "-p", "--output-format", "json", "--tools", "",
               "--no-session-persistence", "--safe-mode"]
        temp_files: list[Path] = []
        if len(system) > MAX_ARG_CHARS:
            path = self.workdir / f"system-{time.time_ns()}.txt"
            path.write_text(system, encoding="utf-8")
            temp_files.append(path)
            cmd += ["--system-prompt-file", str(path)]
        else:
            cmd += ["--system-prompt", system]
        if req.model:
            cmd += ["--model", req.model]
        if req.effort:
            cmd += ["--effort", req.effort]
        if req.json_schema is not None:
            if not req.json_schema:
                raise UserError("Schema de saída vazio.")
            cmd += ["--json-schema", json.dumps(req.json_schema, ensure_ascii=False)]

        t0 = time.time()
        try:
            proc = subprocess.run(cmd, input=req.prompt, capture_output=True, text=True, encoding="utf-8",
                                  errors="replace", timeout=req.timeout_s, cwd=self.workdir, env=self._env())
        except subprocess.TimeoutExpired as exc:
            raise UserError(f"`claude -p` não respondeu em {req.timeout_s}s.") from exc
        finally:
            for path in temp_files:
                path.unlink(missing_ok=True)

        data = None
        lines = proc.stdout.strip().splitlines()
        if lines:
            try:
                data = json.loads(lines[-1])
            except json.JSONDecodeError:
                data = None
        if not isinstance(data, dict):
            detail = (proc.stderr or proc.stdout or "").strip()[-800:]
            raise UserError(f"`claude -p` falhou (código {proc.returncode}): {detail or 'sem saída'}")
        if data.get("is_error") or data.get("subtype") != "success":
            status = f" (HTTP {data['api_error_status']})" if data.get("api_error_status") else ""
            raise UserError(f"Claude Code{status}: {data.get('result') or data.get('subtype') or 'erro desconhecido'}")

        models = list((data.get("modelUsage") or {}).keys())
        return {
            "text": data.get("result") or "",
            "structured": data.get("structured_output"),
            "model": models[0] if models else (req.model or None),
            "cost_usd": data.get("total_cost_usd"),
            "duration_ms": data.get("duration_ms") or int((time.time() - t0) * 1000),
            "turns": data.get("num_turns"),
        }
