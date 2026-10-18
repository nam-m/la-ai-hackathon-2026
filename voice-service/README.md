# Voice service (sherpa-onnx voiceprints)

Turns a clip of speech into a voiceprint, so the server can tell who is talking to the wearer. Two speaker models run side by side (3D-Speaker CAM++ and NeMo TitaNet-Large) and their unit vectors are joined into one 384-number print; a dot product of two prints is the average of the two models' cosine scores. Ported from the Speaker ID prototype, where this pair had a 0.23% equal error rate on LibriSpeech.

The service is stateless. The Node server (`server/src/voices/`) keeps the voices, matches them, picks names out of the conversation and serves the dashboard.

## Run

```bash
cd voice-service
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8010
```

The first start downloads the two models (about 130 MB) into `models/` (gitignored). They load in a few seconds after that. `/health` answers right away with `"loaded": false` while they load, and `/embed` returns `503` until they are ready.

Then set `VOICE_URL=http://localhost:8010` in `server/.env` and restart the server. The dashboard is at `http://localhost:8080/voices#key=<FACTS_SECRET>`.

## API

```bash
curl -s localhost:8010/health
curl -s -X POST localhost:8010/embed --data-binary @clip.wav
```

- `POST /embed` takes a 16 kHz mono 16-bit WAV body. If `VOICE_SECRET` is set, it also needs the header `X-Voice-Secret`.
  - 50 ms frames quieter than RMS 0.01 are dropped before embedding.
  - It returns `{dim, whole, first?, second?, seconds, ms}`. `first` and `second` are the two halves of the speech, given only from 3 s of speech. They disagree when a clip holds two voices.
  - It returns `422 too_short` under 0.6 s of speech.
  - It uses at most the first 12 s.
- One embedding of a few seconds takes about 100 to 300 ms on a laptop CPU.

## What the scores mean

- **Same person:** usually 0.6 to 0.9.
- **Different people:** usually under 0.3.
- **Match threshold:** the server counts a match from 0.47 (`VOICE_THRESHOLD`). For a clip under 1 s it needs 0.57.

Calibrate on the real G2 mic with the slider on the dashboard: the prototype was tuned on a laptop mic.
