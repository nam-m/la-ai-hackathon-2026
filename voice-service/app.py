"""Voice service: speaker voiceprints with sherpa-onnx (CAM++ and TitaNet, fused).

POST /embed  body = WAV bytes (16 kHz mono 16-bit), header X-Voice-Secret when VOICE_SECRET is set
             -> {"dim": 384, "whole": [...], "first": [...], "second": [...], "seconds": 2.4, "ms": 140}
             "first"/"second" (the two halves of the speech) only from 3 s of speech, to tell one voice from two.
             422 too_short under 0.6 s of speech, 503 while the models are still loading
GET  /health -> {"ok": true, "loaded": true, "models": [...], "dim": 384, "error": null}

Stateless: the Node server keeps the voices and does the matching. Ported from the Speaker ID prototype.
Run:  uvicorn app:app --host 0.0.0.0 --port 8010
Env:  VOICE_SECRET (optional, shared with the Node server)
"""
import io
import os
import threading
import time
import urllib.request
import wave
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.concurrency import run_in_threadpool

ROOT = Path(__file__).parent
MODELS_DIR = ROOT / "models"
MODEL_BASE_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/"  # sic, the real tag
# Two models, scores averaged: CAM++ was the most accurate on normal speech in the prototype's benchmark,
# TitaNet the most robust when the same person sounds different; together they beat either alone.
MODEL_FILES = ["3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx", "nemo_en_titanet_large.onnx"]
SECRET = os.environ.get("VOICE_SECRET", "")

SR = 16000
FRAME = SR // 20          # 50 ms frames for the silence gate
SILENCE_RMS = 0.01        # frames below this RMS count as silence and are dropped
MIN_SPEECH = 0.6          # seconds of speech needed for a voiceprint (the server wants more to trust a short one)
MIN_HALVES = 3.0          # seconds of speech needed to compare its halves (one voice or two)
MAX_SECONDS = 12.0

extractors = []
load_error = None
lock = threading.Lock()  # one inference at a time


def load_extractor(file):
    import sherpa_onnx

    path = MODELS_DIR / file
    if not path.exists():
        MODELS_DIR.mkdir(exist_ok=True)
        print(f"[voice] downloading {MODEL_BASE_URL + file}", flush=True)
        tmp = path.with_suffix(".part")
        urllib.request.urlretrieve(MODEL_BASE_URL + file, tmp)
        tmp.rename(path)
    cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(path), num_threads=2, provider="cpu")
    ext = sherpa_onnx.SpeakerEmbeddingExtractor(cfg)
    print(f"[voice] loaded {file} ({path.stat().st_size / 1e6:.1f} MB), dim={ext.dim}", flush=True)
    return ext


def load_models():
    """Runs in a background thread so /health answers (loaded: false) while the models download."""
    global extractors, load_error
    try:
        extractors = [load_extractor(f) for f in MODEL_FILES]
    except Exception as e:  # keep serving /health so the failure is visible
        load_error = f"{type(e).__name__}: {e}"
        print(f"[voice] models failed to load: {load_error}", flush=True)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    threading.Thread(target=load_models, daemon=True).start()
    yield


app = FastAPI(title="voice-service", lifespan=lifespan)


def embed(samples):
    # Joining the unit vectors and renormalizing makes a dot product the average of the models' cosines.
    parts = []
    for ext in extractors:
        s = ext.create_stream()
        s.accept_waveform(SR, samples)
        s.input_finished()
        e = np.array(ext.compute(s), dtype=np.float32)
        parts.append(e / np.linalg.norm(e))
    emb = np.concatenate(parts)
    return emb / np.linalg.norm(emb)


def voiced(audio):
    """Only the 50 ms frames above the silence gate, so pauses don't dilute the voiceprint."""
    n = len(audio) // FRAME
    if not n:
        return audio[:0]
    frames = audio[: n * FRAME].reshape(n, FRAME)
    keep = np.sqrt(np.mean(frames**2, axis=1)) >= SILENCE_RMS
    return frames[keep].reshape(-1)


def voiceprints(speech):
    with lock:
        out = {"whole": embed(speech)}
        if len(speech) >= MIN_HALVES * SR:
            half = len(speech) // 2
            out["first"], out["second"] = embed(speech[:half]), embed(speech[half:])
    return {k: [round(float(x), 6) for x in v] for k, v in out.items()}


def read_wav(body):
    with wave.open(io.BytesIO(body)) as w:
        if w.getsampwidth() != 2:
            raise ValueError("audio must be 16-bit")
        sr, channels, raw = w.getframerate(), w.getnchannels(), w.readframes(w.getnframes())
    audio = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    return audio, sr


@app.get("/health")
def health():
    return {"ok": True, "loaded": len(extractors) == len(MODEL_FILES), "models": MODEL_FILES,
            "dim": sum(e.dim for e in extractors) or None, "error": load_error}


@app.post("/embed")
async def embed_route(request: Request, x_voice_secret: str = Header(default="")):
    if SECRET and x_voice_secret != SECRET:
        raise HTTPException(status_code=401, detail="unauthorized")
    try:
        audio, sr = read_wav(await request.body())
    except Exception:
        raise HTTPException(status_code=400, detail="body must be a 16-bit WAV file")
    if sr != SR:
        raise HTTPException(status_code=400, detail="audio must be 16 kHz")
    if len(extractors) != len(MODEL_FILES):
        raise HTTPException(status_code=503, detail=load_error or "models still loading")

    speech = voiced(audio[: int(MAX_SECONDS * SR)])
    seconds = len(speech) / SR
    if seconds < MIN_SPEECH:
        raise HTTPException(status_code=422, detail="too_short")
    t0 = time.time()
    prints = await run_in_threadpool(voiceprints, speech)
    return {"dim": len(prints["whole"]), **prints, "seconds": round(seconds, 2), "ms": int((time.time() - t0) * 1000)}
