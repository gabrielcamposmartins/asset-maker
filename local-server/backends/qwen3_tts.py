"""Backend Qwen3-TTS — fala com speakers pré-definidos, voice design e clonagem de voz.

Consistência de voz entre gerações é o foco:

- PERFIS DE VOZ persistentes (<models-dir>/qwen3-tts/vozes/<nome>/): áudio de referência
  fixo + transcrição + seed. Vozes criadas por descrição (VoiceDesign) ou por speaker +
  estilo (CustomVoice) viram referência para o modelo Base — o fluxo "design → clone"
  recomendado pela Qwen;
- o PROMPT DE CLONAGEM (códigos da referência + embedding do speaker) é calculado uma
  única vez por perfil/modelo e salvo em disco: toda geração usa exatamente o mesmo
  condicionamento, inclusive depois de reiniciar o servidor;
- SEED fixa reaplicada em cada trecho, amostragem conservadora ("estável"), divisão de
  textos longos em frases (evita a voz "derivar" em áudios longos) e normalização de
  volume completam o pacote.
"""

import hashlib
import importlib.util
import json
import random
import re
import shutil
import threading
import time
from dataclasses import fields
from datetime import datetime
from pathlib import Path
from typing import Literal

import numpy as np
import soundfile as sf
import torch
from pydantic import BaseModel, Field

from audio_utils import concat_with_pauses, decode_audio, encode_wav_data_url, normalize, split_text, trim_silence
from backends import UserError
from model_cache import ModelCache

REPOS = {
    ("base", "1.7B"): "Qwen3-TTS-12Hz-1.7B-Base",
    ("base", "0.6B"): "Qwen3-TTS-12Hz-0.6B-Base",
    ("custom", "1.7B"): "Qwen3-TTS-12Hz-1.7B-CustomVoice",
    ("custom", "0.6B"): "Qwen3-TTS-12Hz-0.6B-CustomVoice",
    ("design", "1.7B"): "Qwen3-TTS-12Hz-1.7B-VoiceDesign",  # só existe em 1.7B
}

SPEAKERS = ["Aiden", "Ryan", "Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ono_Anna", "Sohee"]
LANGUAGES = ["Auto", "Chinese", "English", "Japanese", "Korean", "German",
             "French", "Russian", "Portuguese", "Spanish", "Italian"]


def _sampling(temperature: float, top_k: int, top_p: float) -> dict:
    # o "subtalker" gera os codebooks residuais — recebe a mesma amostragem do talker
    return {
        "temperature": temperature, "top_k": top_k, "top_p": top_p,
        "subtalker_temperature": temperature, "subtalker_top_k": top_k, "subtalker_top_p": top_p,
    }


# Medido com 6 seeds no mesmo texto: "estavel" entrou em loop (não emite o fim da fala) em 2 delas,
# "equilibrado" em nenhuma — por isso ele é o padrão.
SAMPLING_PRESETS = {
    "estavel": _sampling(0.6, 20, 0.85),
    "equilibrado": _sampling(0.75, 35, 0.95),
    "padrao": {},  # generation_config.json do modelo (0.9 / top_k 50 / top_p 1.0)
    "expressivo": _sampling(1.0, 80, 1.0),
}

ATTN_IMPL = "flash_attention_2" if importlib.util.find_spec("flash_attn") else "sdpa"
VOICE_NAME_RE = re.compile(r"^[\w\- ]{1,64}$")
CJK_RE = re.compile(r"[぀-ヿ㐀-鿿가-힯]")


class VoiceRequest(BaseModel):
    name: str
    source: Literal["design", "speaker", "audio"]
    instruct: str = ""          # descrição (design) ou estilo/emoção (speaker)
    speaker: str = "Aiden"
    ref_text: str = ""          # frase falada (design/speaker) ou transcrição do áudio
    ref_audio: str | None = None  # dataURL/base64 (source=audio)
    language: str = "Auto"
    seed: int = Field(42, ge=0)
    x_vector_only: bool = False
    overwrite: bool = False
    model_size: Literal["1.7B", "0.6B"] = "1.7B"


class TTSRequest(BaseModel):
    text: str
    mode: Literal["voice", "speaker", "design"] = "voice"
    voice: str = ""
    speaker: str = "Aiden"
    instruct: str = ""
    language: str = "Auto"
    model_size: Literal["1.7B", "0.6B"] = "1.7B"
    sampling: Literal["estavel", "equilibrado", "padrao", "expressivo"] = "equilibrado"
    seed_mode: Literal["profile", "fixed", "random"] = "profile"
    seed: int = Field(42, ge=0)
    take: int = Field(0, ge=0, le=64)
    split: bool = True
    max_chars: int = Field(220, ge=40, le=4000)
    pause_ms: int = Field(250, ge=0, le=5000)
    normalize: Literal["rms", "peak", "off"] = "rms"
    trim_silence: bool = True


def seed_everything(seed: int) -> None:
    seed = int(seed) % (2**32)
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


TOKENS_PER_SECOND = 12.5  # tokenizer de 12 Hz: 1 token = 1920 amostras a 24 kHz


def max_tokens_for(text: str) -> int:
    """Limite de tokens ~2× a duração esperada da fala — corta gerações que não terminam."""
    cjk = len(CJK_RE.findall(text))
    return int(min(4096, 80 + 1.8 * (len(text) - cjk) + 5 * cjk))


class Qwen3TTSBackend:
    def __init__(self, models_dir: Path, cache: ModelCache, device: str):
        self.root = Path(models_dir) / "qwen3-tts"
        self.voices_dir = self.root / "vozes"
        self.voices_dir.mkdir(parents=True, exist_ok=True)
        self.cache = cache
        self.device = device
        self.dtype = torch.bfloat16 if device.startswith("cuda") else torch.float32
        self.gpu_lock = threading.Lock()
        self._prompts: dict[tuple[str, str], list] = {}  # (voz, repo) -> [VoiceClonePromptItem]

    # ---------------- modelos ----------------

    def info(self) -> dict:
        return {
            "speakers": SPEAKERS,
            "languages": LANGUAGES,
            "sampling_presets": list(SAMPLING_PRESETS),
            "models": {f"{kind}-{size}": (self.root / repo / "config.json").exists()
                       for (kind, size), repo in REPOS.items()},
            "models_dir": str(self.root),
            "voices_dir": str(self.voices_dir),
            "attention": ATTN_IMPL,
        }

    @staticmethod
    def _repo(kind: str, size: str) -> str:
        return REPOS.get((kind, size)) or REPOS[(kind, "1.7B")]

    def _model(self, kind: str, size: str, log: list[str]):
        repo = self._repo(kind, size)
        path = self.root / repo
        if not (path / "config.json").exists():
            small = " -Small" if "0.6B" in repo else ""
            raise UserError(
                f"Modelo {repo} não encontrado em {path}. Baixe com: "
                f"powershell -ExecutionPolicy Bypass -File local-server\\download-models.ps1{small}"
            )

        def load():
            from qwen_tts import Qwen3TTSModel

            t0 = time.time()
            kwargs = {"device_map": self.device, "dtype": self.dtype}
            try:
                model = Qwen3TTSModel.from_pretrained(str(path), attn_implementation=ATTN_IMPL, **kwargs)
            except (ImportError, ValueError):
                model = Qwen3TTSModel.from_pretrained(str(path), **kwargs)
            log.append(f"Modelo {repo} carregado em {time.time() - t0:.1f}s ({self.device}).")
            return model

        return self.cache.get(repo, load)

    # ---------------- perfis de voz ----------------

    @staticmethod
    def _check_name(name: str) -> str:
        name = (name or "").strip()
        if not VOICE_NAME_RE.match(name) or name.startswith("."):
            raise UserError("Nome de voz inválido — use letras, números, espaço, _ ou - (até 64 caracteres).")
        return name

    def _read_profile(self, name: str) -> dict:
        path = self.voices_dir / self._check_name(name) / "profile.json"
        if not path.exists():
            raise UserError(f"A voz “{name}” não existe no servidor. Crie-a com o node “Qwen3-TTS — Voz”.")
        return json.loads(path.read_text(encoding="utf-8"))

    def list_voices(self) -> list[dict]:
        voices = []
        for d in sorted(self.voices_dir.iterdir(), key=lambda p: p.name.lower()):
            path = d / "profile.json"
            if path.exists():
                try:
                    voices.append(json.loads(path.read_text(encoding="utf-8")))
                except (OSError, json.JSONDecodeError):
                    pass
        return voices

    def reference_path(self, name: str) -> Path:
        path = self.voices_dir / self._check_name(name) / "reference.wav"
        if not path.exists():
            raise UserError(f"A voz “{name}” não existe no servidor.")
        return path

    def delete_voice(self, name: str) -> dict:
        name = self._check_name(name)
        vdir = self.voices_dir / name
        if not vdir.exists():
            raise UserError(f"A voz “{name}” não existe no servidor.")
        with self.gpu_lock:
            shutil.rmtree(vdir)
            self._forget_prompts(name)
        return {"deleted": name}

    def _forget_prompts(self, name: str) -> None:
        for key in [k for k in self._prompts if k[0] == name]:
            del self._prompts[key]

    @staticmethod
    def _spec(req: VoiceRequest) -> dict:
        """O que define a voz — usado para avisar quando um perfil existente difere do pedido."""
        spec = {"source": req.source, "language": req.language, "seed": req.seed, "ref_text": req.ref_text.strip()}
        if req.source == "design":
            spec["instruct"] = req.instruct.strip()
        elif req.source == "speaker":
            spec.update(speaker=req.speaker, instruct=req.instruct.strip(), model_size=req.model_size)
        else:
            spec.update(audio_sha1=hashlib.sha1((req.ref_audio or "").encode()).hexdigest(),
                        x_vector_only=req.x_vector_only)
        return spec

    @staticmethod
    def _duration_warning(duration: float) -> str | None:
        """A duração da referência é o que mais estraga a clonagem, nos dois extremos."""
        if duration < 3:
            return (f"Referência de {duration:.1f} s é curta demais: a clonagem fica instável e a voz varia "
                    f"entre as falas. O ideal é 5–15 s.")
        if duration > 25:
            return (f"Referência de {duration:.1f} s é longa demais (o ideal é 5–15 s). Com referências longas "
                    f"o modelo tende a EMENDAR o fim da referência no começo de cada fala gerada — se a sua "
                    f"frase de referência termina com uma exclamação curta, ela vira um prefixo em tudo. "
                    f"Recrie a voz com uma frase curta.")
        return None

    # A frase de referência é FALADA INTEIRA pelo modelo para criar a voz, a cerca de 1 s de áudio
    # por 11 s de GPU. Acima deste limite a geração leva horas E o perfil sai inútil (referência
    # longa faz o modelo emendar o fim dela no começo de cada fala), então é recusada antes de
    # encostar na GPU. O limite é em SEGUNDOS, não em caracteres: um caractere japonês vale quase
    # 3× um latino em duração, e era justamente um roteiro em japonês que virou 2 h de geração.
    REF_TEXT_MAX_SECONDS = 30          # o aviso pós-geração já chama 25 s de prejudicial

    @staticmethod
    def _ref_text_seconds(text: str) -> float:
        """Duração estimada da fala, com os mesmos pesos de max_tokens_for — que dá ~2× a duração,
        mas sem o teto de 4096: é o teto que esconde o tamanho real de um texto enorme."""
        cjk = len(CJK_RE.findall(text))
        return (80 + 1.8 * (len(text) - cjk) + 5 * cjk) / 2 / TOKENS_PER_SECOND

    @classmethod
    def _check_ref_text(cls, text: str, source: str) -> None:
        if source == "audio":
            return                     # na clonagem o texto é transcrição, não é falado
        segundos = cls._ref_text_seconds(text)
        if segundos <= cls.REF_TEXT_MAX_SECONDS:
            return
        dur = f"{segundos / 60:.0f} min" if segundos >= 90 else f"{segundos:.0f} s"
        raise UserError(
            f"A frase de referência tem {len(text)} caracteres — cerca de {dur} de fala, muito acima do "
            f"limite de {cls.REF_TEXT_MAX_SECONDS} s. Ela é FALADA INTEIRA pelo modelo para criar a voz "
            f"(1 s de áudio custa ~11 s de GPU), e uma referência longa estraga a clonagem: o modelo passa "
            f"a emendar o fim dela no começo de cada fala. Use UMA frase de 5–15 s. "
            f"Se o texto longo veio da entrada “transcrição”, desconecte-a: fora da clonagem por áudio, "
            f"ela substitui a frase de referência digitada no node."
        )

    def create_voice(self, req: VoiceRequest) -> dict:
        log: list[str] = []
        name = self._check_name(req.name)
        self._check_ref_text(req.ref_text.strip(), req.source)
        vdir = self.voices_dir / name
        spec = self._spec(req)

        if (vdir / "profile.json").exists() and not req.overwrite:
            profile = self._read_profile(name)
            warning = None
            if profile.get("spec") != spec:
                warning = (f"A voz “{name}” já existe com parâmetros diferentes — o perfil salvo foi mantido "
                           f"para preservar a consistência. Marque “Recriar se a voz já existir” para substituí-la.")
            log.append(f"Voz “{name}” já existe — perfil reutilizado (mesma referência, mesma seed).")
            ref_wav, ref_sr = sf.read(vdir / "reference.wav", dtype="float32")
            # o perfil reutilizado é o que roda todo dia: o aviso de duração precisa aparecer aqui também
            dur_warn = self._duration_warning(len(ref_wav) / ref_sr)
            if dur_warn:
                warning = f"{warning}\n{dur_warn}" if warning else dur_warn
            return {"voice": profile, "reference_audio": encode_wav_data_url(ref_wav, ref_sr),
                    "reused": True, "warning": warning, "log": log}

        with self.gpu_lock:
            wav, sr = self._make_reference(req, log)
            wav = normalize(trim_silence(wav, sr), "peak")
            duration = len(wav) / sr
            warning = self._duration_warning(duration)
            if warning:
                log.append("⚠ " + warning)

            if vdir.exists():
                shutil.rmtree(vdir)
            self._forget_prompts(name)
            vdir.mkdir(parents=True)
            sf.write(vdir / "reference.wav", wav, sr, subtype="PCM_16")
            profile = {
                "name": name,
                "source": req.source,
                "speaker": req.speaker if req.source == "speaker" else None,
                "instruct": req.instruct.strip(),
                "ref_text": req.ref_text.strip(),
                "language": req.language,
                "seed": req.seed,
                "x_vector_only": req.x_vector_only,
                "duration": round(duration, 2),
                "sample_rate": sr,
                "created": datetime.now().isoformat(timespec="seconds"),
                "spec": spec,
            }
            (vdir / "profile.json").write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding="utf-8")
            log.append(f"Voz “{name}” salva em {vdir} ({duration:.1f} s de referência).")
            # já calcula o prompt de clonagem: valida a referência e agiliza a 1ª fala
            try:
                self._clone_prompt(profile, req.model_size, log)
            except UserError as exc:
                log.append(f"⚠ Prompt de clonagem não calculado agora: {exc}")

        return {"voice": profile, "reference_audio": encode_wav_data_url(wav, sr),
                "reused": False, "warning": warning, "log": log}

    def _make_reference(self, req: VoiceRequest, log: list[str]) -> tuple[np.ndarray, int]:
        text = req.ref_text.strip()
        if req.source == "audio":
            if not req.ref_audio:
                raise UserError("Origem “áudio de referência”: conecte um áudio na entrada do node.")
            if not text and not req.x_vector_only:
                raise UserError("Informe a transcrição exata do áudio de referência (ou ative o modo x-vector).")
            try:
                return decode_audio(req.ref_audio)
            except ValueError as exc:
                raise UserError(str(exc)) from exc

        if not text:
            raise UserError("Informe a frase de referência — é ela que será falada para criar a voz.")
        language = self._language(req.language)
        instruct = req.instruct.strip()
        sampling = SAMPLING_PRESETS["equilibrado"]
        if req.source == "design":
            if not instruct:
                raise UserError("Descreva a voz (idade, gênero, timbre, ritmo, emoção…).")
            model = self._model("design", "1.7B", log)
            wav, sr = self._generate_checked(
                lambda t, kw: model.generate_voice_design(text=t, instruct=instruct, language=language, **kw),
                text, sampling, req.seed, log, self._repo("design", "1.7B"))
            log.append("Voz criada por descrição (VoiceDesign) — vira a referência fixa do perfil.")
        else:
            speaker = self._speaker(req.speaker)
            model = self._model("custom", req.model_size, log)
            wav, sr = self._generate_checked(
                lambda t, kw: model.generate_custom_voice(text=t, speaker=speaker, language=language,
                                                          instruct=instruct or None, **kw),
                text, sampling, req.seed, log, self._repo("custom", req.model_size))
            log.append(f"Referência gerada com o speaker {speaker} — vira a referência fixa do perfil.")
        return wav, sr

    def _generate_checked(self, generate, text: str, sampling: dict, seed: int, log: list[str],
                          repo: str, label: str = "") -> tuple[np.ndarray, int]:
        """Gera um trecho com seed fixa. Se a geração não terminar (bate no limite de tokens — loop
        típico de TTS autoregressivo), refaz com seeds derivadas; o resultado continua determinístico."""
        max_new = max_tokens_for(text)
        kwargs = dict(sampling, max_new_tokens=max_new)
        for attempt in range(3):
            attempt_seed = seed + 1000 * attempt
            seed_everything(attempt_seed)
            try:
                wavs, sr = generate(text, kwargs)
            except torch.cuda.OutOfMemoryError:
                log.append("⚠ VRAM insuficiente — descarregando os outros modelos e tentando de novo.")
                self.cache.unload(keep=repo)
                seed_everything(attempt_seed)
                wavs, sr = generate(text, kwargs)
            wav = np.asarray(wavs[0], dtype=np.float32)
            if len(wav) / sr < 0.97 * max_new / TOKENS_PER_SECOND:
                return wav, int(sr)
            retry = " — refazendo com outra seed." if attempt < 2 else " — mantida; tente outra seed ou amostragem."
            log.append(f"⚠ {label}a geração não terminou com a seed {attempt_seed} "
                       f"(atingiu o limite de {max_new} tokens){retry}")
        return wav, int(sr)

    def _clone_prompt(self, profile: dict, size: str, log: list[str]) -> list:
        """Prompt de clonagem do perfil para o modelo Base do tamanho pedido (memória → disco → cálculo)."""
        from qwen_tts.inference.qwen3_tts_model import VoiceClonePromptItem

        name = profile["name"]
        repo = self._repo("base", size)
        key = (name, repo)
        if key in self._prompts:
            return self._prompts[key]

        path = self.voices_dir / name / f"prompt-{repo}.pt"
        if path.exists():
            data = torch.load(path, map_location=self.device, weights_only=True)
            items = [VoiceClonePromptItem(**data)]
            log.append(f"Prompt de clonagem de “{name}” lido do disco — condicionamento idêntico às gerações anteriores.")
        else:
            model = self._model("base", size, log)
            wav, sr = sf.read(self.voices_dir / name / "reference.wav", dtype="float32")
            items = model.create_voice_clone_prompt(
                ref_audio=(wav, sr),
                ref_text=profile.get("ref_text") or None,
                x_vector_only_mode=bool(profile.get("x_vector_only")),
            )
            item = items[0]
            data = {}
            for f in fields(item):
                value = getattr(item, f.name)
                data[f.name] = value.detach().cpu() if torch.is_tensor(value) else value
            torch.save(data, path)
            log.append(f"Prompt de clonagem de “{name}” calculado e salvo ({path.name}).")
        self._prompts[key] = items
        return items

    # ---------------- síntese ----------------

    @staticmethod
    def _language(language: str) -> str:
        if language not in LANGUAGES:
            raise UserError(f"Idioma inválido: {language}. Opções: {', '.join(LANGUAGES)}.")
        return language

    @staticmethod
    def _speaker(speaker: str) -> str:
        if speaker not in SPEAKERS:
            raise UserError(f"Speaker inválido: {speaker}. Opções: {', '.join(SPEAKERS)}.")
        return speaker

    @staticmethod
    def _resolve_seed(req: TTSRequest, profile: dict | None) -> int:
        if req.seed_mode == "random":
            base = random.randint(0, 2**31 - 1)
        elif req.seed_mode == "profile" and profile is not None:
            base = int(profile.get("seed", req.seed))
        else:
            base = req.seed
        return base + req.take

    def synthesize(self, req: TTSRequest) -> dict:
        log: list[str] = []
        text = req.text.strip()
        if not text:
            raise UserError("Texto vazio.")
        language = self._language(req.language)
        instruct = req.instruct.strip()
        profile = self._read_profile(req.voice) if req.mode == "voice" else None
        speaker = self._speaker(req.speaker) if req.mode == "speaker" else None
        if req.mode == "design" and not instruct:
            raise UserError("Voice design: descreva a voz no campo “Descrição da voz”.")
        if req.mode == "voice" and instruct:
            log.append("Estilo/emoção ignorado: vozes clonadas não aceitam instrução (limitação do modelo Base).")

        seed = self._resolve_seed(req, profile)
        chunks = split_text(text, req.max_chars) if req.split else [re.sub(r"\s+", " ", text)]
        sampling = SAMPLING_PRESETS[req.sampling]
        t0 = time.time()

        with self.gpu_lock:
            if req.mode == "voice":
                prompt = self._clone_prompt(profile, req.model_size, log)
                model = self._model("base", req.model_size, log)
                repo = self._repo("base", req.model_size)

                def generate(chunk, kwargs):
                    return model.generate_voice_clone(text=chunk, language=language,
                                                      voice_clone_prompt=prompt, **kwargs)
            elif req.mode == "speaker":
                model = self._model("custom", req.model_size, log)
                repo = self._repo("custom", req.model_size)

                def generate(chunk, kwargs):
                    return model.generate_custom_voice(text=chunk, speaker=speaker, language=language,
                                                       instruct=instruct or None, **kwargs)
            else:
                model = self._model("design", "1.7B", log)
                repo = self._repo("design", "1.7B")

                def generate(chunk, kwargs):
                    return model.generate_voice_design(text=chunk, instruct=instruct, language=language, **kwargs)

            pieces: list[np.ndarray] = []
            sr = 24000
            for i, chunk in enumerate(chunks):
                # mesma seed em todo trecho: resultado reprodutível e homogêneo
                label = f"Trecho {i + 1}: " if len(chunks) > 1 else ""
                piece, sr = self._generate_checked(generate, chunk, sampling, seed, log, repo, label)
                if req.trim_silence:
                    piece = trim_silence(piece, sr)
                pieces.append(piece)

                if req.mode == "design" and i == 0 and len(chunks) > 1:
                    # voice design sorteia uma voz a cada chamada: o 1º trecho vira referência
                    # e os demais são clonados dele, mantendo a mesma voz no áudio inteiro
                    base = self._model("base", req.model_size, log)
                    repo = self._repo("base", req.model_size)
                    ref_prompt = base.create_voice_clone_prompt(ref_audio=(piece, sr), ref_text=chunk)

                    def generate(c, kw, base=base, ref_prompt=ref_prompt):
                        return base.generate_voice_clone(text=c, language=language,
                                                         voice_clone_prompt=ref_prompt, **kw)
                    log.append("Voice design: o 1º trecho virou referência e os demais foram clonados dele.")

            audio = normalize(concat_with_pauses(pieces, sr, req.pause_ms), req.normalize)

        duration = len(audio) / sr
        log.append(f"{len(chunks)} trecho(s) · seed {seed} · amostragem “{req.sampling}” · "
                   f"{duration:.1f} s de áudio gerados em {time.time() - t0:.1f} s.")
        return {"audio": encode_wav_data_url(audio, sr), "sample_rate": sr, "duration": round(duration, 2),
                "seed": seed, "chunks": len(chunks), "log": log}
