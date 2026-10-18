"""Tone service: estimated tone of voice with emotion2vec+.

POST /tone   body = WAV bytes (16 kHz mono 16-bit), header X-Tone-Secret
             -> {"model": ..., "scores": {"fearful": 0.61, ...}, "top": [...], "seconds": 2.1, "ms": 240}
             422 too short, 503 while the model is still loading
GET  /health -> {"ok": true, "model": ..., "mock": false, "loaded": true, "error": null}

Run:  uvicorn app:app --host 0.0.0.0 --port 8000
Env:  TONE_SECRET (shared with the Node server), TONE_MODEL, TONE_HUB, TONE_MOCK=1
"""
import io
import os
import tempfile
import threading
import time
from contextlib import asynccontextmanager

import numpy as np
import soundfile as sf
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.concurrency import run_in_threadpool

SECRET = os.environ.get("TONE_SECRET", "change-me-tone")
MODEL_ID = os.environ.get("TONE_MODEL", "emotion2vec/emotion2vec_plus_base")
HUB = os.environ.get("TONE_HUB", "hf")  # "hf" outside China, "ms" for ModelScope
MOCK = os.environ.get("TONE_MOCK") == "1"  # fake scores, for testing without the model

LABELS = ["angry", "disgusted", "fearful", "happy", "neutral", "other", "sad", "surprised"]
MIN_SECONDS = 1.0
MAX_SECONDS = 10.0

model = None
load_error = None
model_lock = threading.Lock()  # one inference at a time; the model isn't documented as thread-safe


def load_model():
    """Runs in a background thread so /health answers (loaded: false) while the model downloads."""
    global model, load_error
    try:
        from funasr import AutoModel  # imported here so mock mode needs no torch

        t0 = time.time()
        m = AutoModel(model=MODEL_ID, hub=HUB, disable_update=True)
        model = m
        print(f"[tone] loaded {MODEL_ID} in {time.time() - t0:.1f}s", flush=True)
    except Exception as e:  # keep serving /health so the failure is visible
        load_error = f"{type(e).__name__}: {e}"
        print(f"[tone] model failed to load: {load_error}", flush=True)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if MOCK:
        print("[tone] MOCK mode: returning fake scores", flush=True)
    else:
        threading.Thread(target=load_model, daemon=True).start()
    yield


app = FastAPI(title="tone-service", lifespan=lifespan)


def clean_label(raw: str) -> str:
    # emotion2vec labels look like "恐惧/fearful"; keep the English part.
    return raw.split("/")[-1].strip().lower()


def mock_scores(audio: np.ndarray) -> dict:
    # Deterministic fake: louder audio -> more "fearful". Only for wiring tests.
    rms = float(np.sqrt(np.mean(audio**2))) if audio.size else 0.0
    fear = min(0.9, rms * 8)
    rest = (1 - fear) / (len(LABELS) - 1)
    return {lab: (fear if lab == "fearful" else rest) for lab in LABELS}


def model_scores(audio: np.ndarray, sr: int) -> dict:
    """Blocking inference; called from a worker thread so the event loop (and /health) stays responsive."""
    with model_lock, tempfile.NamedTemporaryFile(suffix=".wav") as f:
        sf.write(f.name, audio, sr, subtype="PCM_16")
        result = model.generate(f.name, granularity="utterance", extract_embedding=False)
    r = result[0]
    scores = {}
    for raw, score in zip(r["labels"], r["scores"]):
        lab = clean_label(raw)
        if lab in LABELS:
            scores[lab] = round(float(score), 4)
    return scores


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_ID, "mock": MOCK, "loaded": MOCK or model is not None, "error": load_error}


@app.post("/tone")
async def tone(request: Request, x_tone_secret: str = Header(default="")):
    if x_tone_secret != SECRET:
        raise HTTPException(status_code=401, detail="unauthorized")

    body = await request.body()
    try:
        audio, sr = sf.read(io.BytesIO(body), dtype="float32")
    except Exception:
        raise HTTPException(status_code=400, detail="body must be a WAV file")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != 16000:
        raise HTTPException(status_code=400, detail="audio must be 16 kHz")

    seconds = len(audio) / sr
    if seconds < MIN_SECONDS:
        raise HTTPException(status_code=422, detail="too_short")
    audio = audio[: int(MAX_SECONDS * sr)]

    t0 = time.time()
    if MOCK:
        scores = mock_scores(audio)
    else:
        if model is None:
            raise HTTPException(status_code=503, detail=load_error or "model still loading")
        scores = await run_in_threadpool(model_scores, audio, sr)

    top = [k for k, _ in sorted(scores.items(), key=lambda kv: kv[1], reverse=True)[:3]]
    return {"model": "mock" if MOCK else MODEL_ID, "scores": scores, "top": top, "seconds": round(seconds, 2), "ms": int((time.time() - t0) * 1000)}
