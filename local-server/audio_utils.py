"""Utilidades de áudio compartilhadas pelos backends: decodificação, pós-processamento e WAV."""

import base64
import io
import re

import numpy as np
import soundfile as sf


def decode_audio(data: str) -> tuple[np.ndarray, int]:
    """Decodifica um dataURL (ou base64 puro) de áudio em (mono float32, sample rate)."""
    if data.startswith("data:"):
        data = data.split(",", 1)[1]
    raw = base64.b64decode(data)
    try:
        wav, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
    except Exception as exc:
        raise ValueError(
            "Formato de áudio não suportado — use WAV, FLAC, OGG ou MP3 "
            "(o node “Áudio (upload)” já converte para WAV)."
        ) from exc
    return wav.mean(axis=1).astype(np.float32), int(sr)


def encode_wav_data_url(wav: np.ndarray, sr: int) -> str:
    buf = io.BytesIO()
    sf.write(buf, np.clip(wav, -1.0, 1.0), sr, format="WAV", subtype="PCM_16")
    return "data:audio/wav;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def trim_silence(wav: np.ndarray, sr: int, top_db: float = 40.0, pad_ms: int = 60) -> np.ndarray:
    """Remove silêncio do início e do fim, mantendo uma pequena margem."""
    if wav.size == 0:
        return wav
    import librosa

    _, (start, end) = librosa.effects.trim(wav, top_db=top_db)
    pad = int(sr * pad_ms / 1000)
    return wav[max(0, start - pad): min(len(wav), end + pad)]


def normalize(wav: np.ndarray, mode: str, target_db: float = -20.0, peak_db: float = -1.0) -> np.ndarray:
    """Iguala o volume entre gerações: 'rms' (loudness média), 'peak' (pico) ou 'off'."""
    if wav.size == 0 or mode == "off":
        return wav
    peak_limit = 10 ** (peak_db / 20)
    if mode == "rms":
        rms = float(np.sqrt(np.mean(np.square(wav))))
        if rms > 1e-6:
            wav = wav * (10 ** (target_db / 20) / rms)
    peak = float(np.max(np.abs(wav)))
    if peak > 1e-6 and (mode == "peak" or peak > peak_limit):
        # no modo rms, só reduz se o ganho fizer o pico passar do limite
        wav = wav * (peak_limit / peak)
    return wav.astype(np.float32)


def concat_with_pauses(pieces: list[np.ndarray], sr: int, pause_ms: int) -> np.ndarray:
    if not pieces:
        return np.zeros(0, dtype=np.float32)
    gap = np.zeros(int(sr * max(0, pause_ms) / 1000), dtype=np.float32)
    out = []
    for i, piece in enumerate(pieces):
        if i:
            out.append(gap)
        out.append(piece.astype(np.float32))
    return np.concatenate(out)


_SENTENCE_END = re.compile(r"(?<=[.!?…;:。！？；])\s+")
_CLAUSE_END = re.compile(r"(?<=[,，、])\s+")


def split_text(text: str, max_chars: int) -> list[str]:
    """Divide o texto em trechos de até max_chars sem quebrar frases.

    Cada linha é uma fronteira rígida; dentro da linha, frases curtas são agrupadas
    e frases longas demais são quebradas em vírgulas e, em último caso, em palavras.
    """
    max_chars = max(40, int(max_chars))
    chunks: list[str] = []
    for line in text.splitlines():
        line = re.sub(r"\s+", " ", line).strip()
        if not line:
            continue
        pieces: list[str] = []
        for sentence in _SENTENCE_END.split(line):
            if len(sentence) <= max_chars:
                pieces.append(sentence)
                continue
            for part in _CLAUSE_END.split(sentence):
                while len(part) > max_chars:
                    cut = part.rfind(" ", 0, max_chars)
                    if cut <= 0:
                        cut = max_chars
                    pieces.append(part[:cut].strip())
                    part = part[cut:].strip()
                if part:
                    pieces.append(part)
        current = ""
        for piece in pieces:
            if current and len(current) + 1 + len(piece) > max_chars:
                chunks.append(current)
                current = piece
            else:
                current = f"{current} {piece}".strip()
        if current:
            chunks.append(current)
    return chunks
