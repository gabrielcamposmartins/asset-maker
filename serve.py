"""Servidor do editor Asset Maker — substitui o `python -m http.server`.

- serve os arquivos do projeto sem cache (alterações aparecem com um F5 comum);
- liga e desliga o servidor local de modelos (local-server/) pelos botões em 🔑 Chaves.

Uso:
    python serve.py                  # http://localhost:8741
    python serve.py --open           # e já abre o navegador
    python serve.py --port 8742 --models-dir E:\\ia --max-loaded 1

Só usa a biblioteca padrão do Python.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOCAL_SERVER_DIR = ROOT / "local-server"
LOG_PATH = LOCAL_SERVER_DIR / "logs" / "server.log"
CREATE_NO_WINDOW = 0x08000000  # Windows: o servidor de modelos roda sem abrir console

DADOS_DIR = ROOT / "dados"
DB_PATH = DADOS_DIR / "estado.db"

BACKUPS_DIR = ROOT / "backups"
BACKUP_FORMAT = "assets-pipeline-backup"
BACKUP_MAX_FILES = 12                    # quantos arquivos ficam guardados
BACKUP_MAX_BYTES = 1 * 1024 ** 3         # e o teto total (1 GB)
BACKUP_MIN_FREE = 3 * 1024 ** 3          # abaixo disto os mais velhos saem: disco cheio é o que apaga os dados
BACKUP_REFUSE_FREE = 500 * 1024 ** 2     # e abaixo disto nem grava, para não piorar


# ---------------------------------------------------------------- estado em SQLite
#
# O editor continua guardando tudo no navegador (funciona com qualquer servidor estático), mas
# espelha cada mudança aqui. Como o navegador pode apagar o IndexedDB sozinho quando o disco
# enche, este banco é a cópia que NÃO depende dele: na abertura o editor compara o que tem com o
# que está aqui e traz de volta o que faltar.

def db() -> sqlite3.Connection:
    DADOS_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=15)
    con.execute("PRAGMA journal_mode=WAL")   # aguenta leitura e escrita ao mesmo tempo
    con.execute("PRAGMA synchronous=NORMAL")
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS workflows (
            id TEXT PRIMARY KEY, nome TEXT, json TEXT NOT NULL, atualizado INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS sessoes (
            id TEXT PRIMARY KEY, workflow TEXT, tipo TEXT, json TEXT NOT NULL, atualizado INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS biblioteca (
            chave TEXT PRIMARY KEY, json TEXT NOT NULL, atualizado INTEGER NOT NULL);
        """
    )
    return con


def estado_resumo() -> dict:
    """O que existe no banco, sem trazer o conteúdo (as sessões com resultados são enormes)."""
    with db() as con:
        wf = [{"id": i, "nome": n, "bytes": t} for i, n, t in
              con.execute("SELECT id, nome, length(json) FROM workflows ORDER BY atualizado DESC")]
        ses = [{"id": i, "tipo": t, "workflow": w, "bytes": b} for i, t, w, b in
               con.execute("SELECT id, tipo, workflow, length(json) FROM sessoes")]
        bib = [{"chave": c, "bytes": b} for c, b in
               con.execute("SELECT chave, length(json) FROM biblioteca")]
    try:
        tamanho = DB_PATH.stat().st_size
    except OSError:
        tamanho = 0
    return {"workflows": wf, "sessoes": ses, "biblioteca": bib, "arquivo": str(DB_PATH), "bytes": tamanho}


def estado_ler(pedido: dict) -> dict:
    """Devolve só as linhas pedidas — o editor pede apenas o que está faltando nele."""
    wf_ids = [str(x) for x in (pedido.get("workflows") or [])]
    ses_ids = [str(x) for x in (pedido.get("sessoes") or [])]
    chaves = [str(x) for x in (pedido.get("biblioteca") or [])]
    out = {"workflows": [], "sessoes": [], "biblioteca": {}}
    with db() as con:
        for ids, tabela, col, destino in (
            (wf_ids, "workflows", "id", "workflows"),
            (ses_ids, "sessoes", "id", "sessoes"),
        ):
            for i in range(0, len(ids), 200):       # SQLite limita o número de parâmetros
                lote = ids[i:i + 200]
                marcas = ",".join("?" * len(lote))
                for (linha,) in con.execute(f"SELECT json FROM {tabela} WHERE {col} IN ({marcas})", lote):
                    out[destino].append(json.loads(linha))
        for chave in chaves:
            linha = con.execute("SELECT json FROM biblioteca WHERE chave = ?", (chave,)).fetchone()
            if linha:
                out["biblioteca"][chave] = json.loads(linha[0])
    return out


def estado_gravar(dados: dict) -> dict:
    """Grava as linhas que mudaram e, quando o editor manda a lista completa de ids, apaga o que
    ele não tem mais. A lista vazia é ignorada: seria o caso de o navegador ter perdido tudo."""
    agora = int(time.time() * 1000)
    wf = dados.get("workflows") or []
    ses = dados.get("sessoes") or []
    bib = dados.get("biblioteca") or {}
    ids = dados.get("ids") or {}
    gravados = apagados = 0
    with db() as con:
        for w in wf:
            con.execute("INSERT INTO workflows (id, nome, json, atualizado) VALUES (?,?,?,?) "
                        "ON CONFLICT(id) DO UPDATE SET nome=excluded.nome, json=excluded.json, "
                        "atualizado=excluded.atualizado",
                        (str(w.get("id")), str(w.get("name") or ""), json.dumps(w, ensure_ascii=False), agora))
            gravados += 1
        for s in ses:
            con.execute("INSERT INTO sessoes (id, workflow, tipo, json, atualizado) VALUES (?,?,?,?,?) "
                        "ON CONFLICT(id) DO UPDATE SET workflow=excluded.workflow, tipo=excluded.tipo, "
                        "json=excluded.json, atualizado=excluded.atualizado",
                        (str(s.get("id")), str(s.get("workflowId") or ""), str(s.get("kind") or ""),
                         json.dumps(s, ensure_ascii=False), agora))
            gravados += 1
        for chave, valor in bib.items():
            con.execute("INSERT INTO biblioteca (chave, json, atualizado) VALUES (?,?,?) "
                        "ON CONFLICT(chave) DO UPDATE SET json=excluded.json, atualizado=excluded.atualizado",
                        (str(chave), json.dumps(valor, ensure_ascii=False), agora))
            gravados += 1
        # remoções: só quando o editor declara ter pelo menos um workflow (senão é perda de dados)
        # linhas gravadas há menos de 1 minuto são poupadas: com duas abas abertas, a lista de
        # uma delas pode estar desatualizada e apagaria o que a outra acabou de criar
        recente = agora - 60_000
        lista_wf = ids.get("workflows")
        if isinstance(lista_wf, list) and lista_wf:
            marcas = ",".join("?" * len(lista_wf))
            apagados += con.execute(
                f"DELETE FROM workflows WHERE atualizado < ? AND id NOT IN ({marcas})",
                [recente, *[str(x) for x in lista_wf]]).rowcount
        lista_ses = ids.get("sessoes")
        if isinstance(lista_ses, list) and lista_ses and isinstance(lista_wf, list) and lista_wf:
            marcas = ",".join("?" * len(lista_ses))
            apagados += con.execute(
                f"DELETE FROM sessoes WHERE atualizado < ? AND id NOT IN ({marcas})",
                [recente, *[str(x) for x in lista_ses]]).rowcount
    return {"gravados": gravados, "apagados": apagados, **estado_resumo()}


def backup_files() -> list[Path]:
    """Backups do mais novo para o mais velho (o nome já ordena por data)."""
    try:
        return sorted(BACKUPS_DIR.glob("backup-*.json"), reverse=True)
    except OSError:
        return []


def backup_workflow_count(path: Path) -> int | None:
    """Quantos workflows o arquivo tem, lido do nome (…-w3.json). None nos backups antigos."""
    m = re.search(r"-w(\d+)\.json$", path.name)
    return int(m.group(1)) if m else None


def free_bytes() -> int:
    try:
        return shutil.disk_usage(BACKUPS_DIR if BACKUPS_DIR.exists() else ROOT).free
    except OSError:
        return BACKUP_MIN_FREE


def backup_stats() -> dict:
    files = backup_files()
    total = 0
    last = None
    for i, f in enumerate(files):
        try:
            st = f.stat()
        except OSError:
            continue
        total += st.st_size
        if i == 0:
            last = int(st.st_mtime * 1000)
    return {"dir": str(BACKUPS_DIR), "files": len(files), "bytes": total, "last": last,
            "maxFiles": BACKUP_MAX_FILES, "maxBytes": BACKUP_MAX_BYTES}


def rotate_backups() -> int:
    """Apaga os mais velhos até caber nos limites de quantidade, de tamanho e de espaço livre.
    O mais novo nunca sai. Com pouco espaço no disco a retenção encolhe sozinha — manter muitos
    backups num disco cheio é justamente o que faz o navegador apagar os dados do editor."""
    removed = 0
    total = 0
    for i, f in enumerate(backup_files()):
        try:
            size = f.stat().st_size
        except OSError:
            continue
        total += size
        apertado = i > 0 and free_bytes() < BACKUP_MIN_FREE and i >= 2
        if i >= BACKUP_MAX_FILES or (i > 0 and total > BACKUP_MAX_BYTES) or apertado:
            try:
                f.unlink()
                removed += 1
            except OSError:
                pass
    return removed


def write_backup(body: bytes) -> dict:
    data = json.loads(body.decode("utf-8"))
    if not isinstance(data, dict) or data.get("format") != BACKUP_FORMAT:
        raise RuntimeError("O corpo enviado não é um backup do Asset Maker.")
    BACKUPS_DIR.mkdir(parents=True, exist_ok=True)

    # Guarda contra gravar DEPOIS de uma perda: se o navegador apagar o IndexedDB, o editor
    # abre vazio e tentaria salvar um backup sem nenhum workflow — que em poucas horas empurraria
    # os backups bons para fora da rotação. Nesse caso recusamos e avisamos na tela.
    agora = len(data.get("workflows") or [])
    if agora == 0:
        anteriores = [n for n in (backup_workflow_count(f) for f in backup_files()) if n]
        if anteriores:
            raise RuntimeError(
                f"backup recusado: ele não tem nenhum workflow, e o último gravado tem {anteriores[0]}. "
                f"Isso costuma significar que o navegador apagou os dados do editor — restaure um backup "
                f"de backups/ pelo ⇧ Importar antes de continuar."
            )

    livre = free_bytes()
    if livre < BACKUP_REFUSE_FREE:
        raise RuntimeError(
            f"backup não gravado: só restam {livre / 1024 ** 3:.1f} GB no disco. Libere espaço — "
            f"com o disco cheio o navegador apaga os dados do editor sozinho. "
            f"“Limpar backups automáticos” no menu 📋 libera o que está em backups/."
        )

    # os milissegundos evitam que duas cópias no mesmo segundo virem um arquivo só;
    # o -wN no fim diz quantos workflows o arquivo tem, sem precisar abrir 100 MB de JSON
    name = (time.strftime("backup-%Y-%m-%d-%H%M%S")
            + f"-{int(time.time() * 1000) % 1000:03d}-w{agora}.json")
    path = BACKUPS_DIR / name
    tmp = path.with_suffix(".part")
    # grava num .part e só então renomeia: um disco cheio nunca deixa um backup pela metade no lugar do bom
    try:
        tmp.write_bytes(body)
        tmp.replace(path)
    except OSError as exc:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"Não foi possível gravar o backup: {exc}") from exc
    removed = rotate_backups()
    return {**backup_stats(), "file": name, "removed": removed}


def clear_backups() -> dict:
    removed = 0
    freed = 0
    for f in backup_files():
        try:
            size = f.stat().st_size
            f.unlink()
        except OSError:
            continue
        removed += 1
        freed += size
    return {**backup_stats(), "removed": removed, "freed": freed}


class ModelServer:
    """Processo do servidor de modelos (local-server/server.py) controlado pelo editor."""

    def __init__(self, port: int, models_dir: str, max_loaded: int):
        self.port = port
        self.models_dir = models_dir
        self.max_loaded = max_loaded
        self.proc: subprocess.Popen | None = None
        self.started_at: float | None = None
        self.lock = threading.Lock()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def _request(self, path: str, method: str = "GET", timeout: float = 1.5) -> dict:
        req = urllib.request.Request(self.url + path, method=method, data=b"" if method == "POST" else None)
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read() or b"{}")

    def health(self) -> dict | None:
        try:
            return self._request("/health")
        except (OSError, ValueError):
            return None

    def own_alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def python_path(self) -> Path:
        venv = LOCAL_SERVER_DIR / ".venv"
        return venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")

    def status(self) -> dict:
        health = self.health()
        own = self.own_alive()
        return {
            "state": "running" if health else ("starting" if own else "stopped"),
            "managed": own,
            "url": self.url,
            "pid": self.proc.pid if own else None,
            "uptime_s": round(time.time() - self.started_at) if own and self.started_at else None,
            "exit_code": self.proc.poll() if self.proc is not None else None,
            "gpu": (health or {}).get("gpu"),
            "loaded": (health or {}).get("loaded"),
            "installed": self.python_path().exists(),
        }

    def start(self) -> None:
        with self.lock:
            if self.health() or self.own_alive():
                return
            python = self.python_path()
            if not python.exists():
                raise RuntimeError("Ambiente do servidor não instalado — rode: "
                                   "powershell -ExecutionPolicy Bypass -File local-server\\setup.ps1")
            LOG_PATH.parent.mkdir(exist_ok=True)
            env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1")
            env.pop("CLAUDECODE", None)
            with open(LOG_PATH, "w", encoding="utf-8") as log:
                self.proc = subprocess.Popen(
                    [str(python), "server.py", "--models-dir", self.models_dir,
                     "--port", str(self.port), "--max-loaded", str(self.max_loaded)],
                    cwd=LOCAL_SERVER_DIR, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                    env=env, creationflags=CREATE_NO_WINDOW if os.name == "nt" else 0,
                )
            self.started_at = time.time()

    def stop(self) -> None:
        with self.lock:
            # 1) desligamento gracioso — funciona também se o servidor foi aberto pelo start.ps1
            try:
                self._request("/shutdown", "POST", timeout=3)
            except (OSError, ValueError):
                pass
            deadline = time.time() + 10
            while time.time() < deadline and (self.health() or self.own_alive()):
                time.sleep(0.4)
            # 2) se continuar de pé e foi aberto aqui, encerra o processo e os filhos
            if self.own_alive():
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(self.proc.pid), "/T", "/F"], capture_output=True)
                else:
                    self.proc.kill()
                self.proc.wait(timeout=10)

    def log_tail(self, lines: int = 80) -> list[str]:
        try:
            return LOG_PATH.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:]
        except OSError:
            return []


MODEL: ModelServer  # criado em main()


class EditorHandler(SimpleHTTPRequestHandler):
    # no Windows o registro pode mapear .js para text/plain — e o navegador recusa
    # <script type="module"> servido assim (o assistente de IA é um módulo)
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript"}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, format, *args):  # sem uma linha de log por arquivo servido
        pass

    def do_GET(self):
        if self.path.startswith("/__local/"):
            return self._api()
        # backups e banco de estado existem para o disco, não para o navegador
        alvo = self.path.split("?", 1)[0].lstrip("/").lower()
        if alvo.startswith("backups/") or alvo.startswith("dados/"):
            return self.send_error(404)
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/__local/"):
            return self._api()
        self.send_error(405)

    def _json(self, code: int, data: dict) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _api(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        # só o próprio editor: o cabeçalho customizado obriga um preflight CORS em chamadas de
        # outros sites, e este servidor não responde a preflights — elas nunca chegam aqui
        if self.headers.get("X-Assets-Pipeline") != "1":
            return self._json(403, {"detail": "Acesso negado."})
        route = self.path.split("?", 1)[0]
        post = self.command == "POST"
        try:
            if route == "/__local/status":
                data = MODEL.status()
            elif route == "/__local/start" and post:
                MODEL.start()
                data = MODEL.status()
                print(f"  ▶ servidor de modelos iniciado (log: {LOG_PATH})")
            elif route == "/__local/stop" and post:
                MODEL.stop()
                data = MODEL.status()
                print("  ■ servidor de modelos desligado")
            elif route == "/__local/log":
                data = {"lines": MODEL.log_tail()}
            elif route == "/__local/estado/resumo":
                data = estado_resumo()
            elif route == "/__local/estado/ler" and post:
                data = estado_ler(json.loads(body or b"{}"))
            elif route == "/__local/estado" and post:
                data = estado_gravar(json.loads(body or b"{}"))
            elif route == "/__local/backups":
                data = backup_stats()
            elif route == "/__local/backup" and post:
                data = write_backup(body)
            elif route == "/__local/backups/clear" and post:
                data = clear_backups()
                print(f"  🗑 {data['removed']} backup(s) apagado(s) — {data['freed'] / 1024 ** 3:.2f} GB liberados")
            else:
                return self._json(404, {"detail": "Rota desconhecida."})
        except (RuntimeError, ValueError, OSError) as exc:
            return self._json(400, {"detail": str(exc)})
        self._json(200, data)


class LoopbackServer(ThreadingHTTPServer):
    daemon_threads = True
    # no Windows, SO_REUSEADDR deixaria dois servidores dividirem a mesma porta sem erro
    allow_reuse_address = os.name != "nt"


class LoopbackServer6(LoopbackServer):
    address_family = socket.AF_INET6


def main() -> None:
    global MODEL, BACKUPS_DIR, DADOS_DIR, DB_PATH
    parser = argparse.ArgumentParser(description="Servidor do editor Asset Maker")
    parser.add_argument("--port", type=int, default=8741, help="porta do editor (padrão 8741)")
    parser.add_argument("--open", action="store_true", help="abre o editor no navegador")
    parser.add_argument("--server-port", type=int, default=8765, help="porta do servidor de modelos")
    parser.add_argument("--models-dir", default=os.environ.get("ASSETS_MODELS_DIR", r"D:\modelos"))
    parser.add_argument("--max-loaded", type=int, default=2, help="modelos mantidos na GPU ao mesmo tempo")
    parser.add_argument("--dados-dir", default=None,
                        help="pasta do banco de estado (padrão: dados/ no projeto). Use uma separada ao subir uma segunda instância para teste")
    parser.add_argument("--backups-dir", default=None,
                        help="pasta dos backups automáticos (padrão: backups/ no projeto). Use uma pasta separada ao subir uma segunda instância para teste, senão ela concorre pela rotação dos backups reais")
    parser.add_argument("--limpar-backups", "--clear-backups", dest="clear_backups", action="store_true",
                        help="apaga os backups automáticos de backups/ e sai, dizendo quantos GB liberou")
    args = parser.parse_args()
    if args.dados_dir:
        DADOS_DIR = Path(args.dados_dir).expanduser().resolve()
        DB_PATH = DADOS_DIR / "estado.db"
    if args.backups_dir:
        BACKUPS_DIR = Path(args.backups_dir).expanduser().resolve()

    if args.clear_backups:
        alvo = backup_stats()['dir']
        info = clear_backups()
        print(f"  {info['removed']} backup(s) apagado(s) de {alvo} — "
              f"{info['freed'] / 1024 ** 3:.2f} GB liberados.")
        return

    MODEL = ModelServer(args.server_port, args.models_dir, args.max_loaded)
    try:
        servers = [LoopbackServer(("127.0.0.1", args.port), EditorHandler)]
    except OSError:
        print(f"A porta {args.port} já está em uso — feche o outro servidor (ex.: python -m http.server) "
              f"ou use --port.")
        sys.exit(1)
    try:  # também em ::1, para "localhost" responder na hora
        servers.append(LoopbackServer6(("::1", args.port), EditorHandler))
    except OSError:
        pass
    for extra in servers[1:]:
        threading.Thread(target=extra.serve_forever, daemon=True).start()

    url = f"http://localhost:{args.port}"
    bk = backup_stats()
    print(f"\n  Asset Maker — editor em {url}\n"
          f"  Servidor de modelos: {MODEL.url} (ligue/desligue em 🔑 Chaves)\n"
          f"  Estado espelhado em {DB_PATH} ({estado_resumo()['bytes'] / 1024 ** 2:.0f} MB) — não depende do navegador\n"
          f"  Backups automáticos: {bk['files']} arquivo(s), {bk['bytes'] / 1024 ** 3:.2f} GB em {bk['dir']} (--limpar-backups apaga todos)\n"
          f"  Ctrl+C encerra o editor e o servidor de modelos aberto por ele.\n")
    if args.open:
        webbrowser.open(url)
    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if MODEL.own_alive():
            print("  Desligando o servidor de modelos…")
            MODEL.stop()


if __name__ == "__main__":
    main()
