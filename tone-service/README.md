# Tone service (emotion2vec+)

Estimated tone of voice for the wearer's questions. The Node server calls it in the background; it never delays an answer, and results only appear on the family dashboard.

## Run

```bash
cd tone-service
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt          # torch is the big one; on a laptop, CPU is fine
export TONE_SECRET=change-me-tone        # same value as TONE_SECRET in server/.env
uvicorn app:app --host 0.0.0.0 --port 8000
```

The first start downloads the model from Hugging Face (`emotion2vec/emotion2vec_plus_base`, about 1.1 GB; several minutes on venue Wi-Fi, so do it beforehand) and caches it. If Hugging Face is slow, set `TONE_HUB=ms` to use ModelScope with `TONE_MODEL=iic/emotion2vec_plus_base`. Use `emotion2vec_plus_large` only with a GPU.

No model yet? `TONE_MOCK=1 uvicorn app:app --port 8000` returns fake scores (louder = more "fearful") so the server and dashboard can be built against it.

The model loads in the background: `/health` answers right away with `"loaded": false` (and `"error"` if loading failed), and `/tone` returns `503` until it's ready. In Docker the container turns `healthy` only once the model is loaded.

## Test

```bash
curl -s localhost:8000/health
curl -s -X POST localhost:8000/tone -H "X-Tone-Secret: change-me-tone" --data-binary @question.wav
```

Audio must be 16 kHz mono WAV, at least 1 second. Longer than 10 seconds is trimmed.

Record your demo clips on the real G2 so the model hears the same mic: the same question asked calmly and worriedly. Check that `fearful` / `sad` differ between them.

## Making it reachable from the server

The server needs `TONE_URL`. Options:

- **Same machine as the server:** `TONE_URL=http://localhost:8000`.
- **Server on Render/Railway, tone on a laptop:** run a tunnel (`ngrok http 8000` or `cloudflared tunnel --url http://localhost:8000`) and put that HTTPS URL in `TONE_URL`. Keep the laptop awake and on power.
- **Vultr instance:** run it there (also counts for MLH Best Use of Vultr).

## Labels

emotion2vec+ returns: angry, disgusted, fearful, happy, neutral, other, sad, surprised. The dashboard uses **fearful** and **sad** as "worry", compared with the wearer's own earlier questions that day. The models are trained largely on acted speech, so trends against her own baseline are more meaningful than any single score. Check the model card's license before claiming it in the Devpost.
