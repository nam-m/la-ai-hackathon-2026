# Asked & Answered

Even G2 glasses that quietly answer the questions a person with early dementia keeps repeating, using answers their family already gave.

| Folder | Owner | Status |
| --- | --- | --- |
| `glasses-app/` | A: Glasses | A starts it from Even's asr template |
| `server/` | C: Server and matching | Working; see `server/README.md` |
| `server/src/speech/` | B: Speech | ElevenLabs, Deepgram fallback, fake replay; [setup and hardware checks](server/src/speech/README.md) |
| `server/src/creao/` | D: Creao | Logging stubs; replace with real Creao calls |
| `web/` | Family app | React frontend for caregivers (Today, Facts, Settings); see `web/README.md` |
| `server/src/emotion/` + `tone-service/` | C | Tone of voice with emotion2vec+; see `tone-service/README.md` |

Quick start:

```bash
cd server
npm install
cp .env.example .env
npm run dev            # terminal 1
npm run seed-facts     # terminal 2
npm run fake-phone     # terminal 2: prints what the glasses would show
```

With tone (terminal 3, no model needed in mock mode):

```bash
cd tone-service && pip install fastapi uvicorn soundfile numpy
TONE_MOCK=1 uvicorn app:app --port 8000
# then in server/: FAKE_PHONE_NOISE=1 npm run fake-phone
```

## Run everything with Docker

```bash
cp server/.env.example server/.env    # server keys (Gemini, speech, Creao, APP_TOKEN, FACTS_SECRET)
cp .env.example .env                  # TONE_SECRET and tone settings; compose gives these to both services
docker compose up --build             # family app on :3000, server on :8080, tone service on :8000
```

The first build takes a while (PyTorch), and the first start downloads the emotion2vec+ model into a volume, so do both on good Wi-Fi before the demo. Check `http://localhost:8080/health`: `tone.state` turns `on` only after the server has reached the tone service with its model loaded (`not reached yet` until then). `docker compose ps` shows the tone container `healthy` once the model is loaded. For mock mode in Docker: `TONE_MOCK=1` in the root `.env`, not in `server/.env`.

The glasses app (A) still runs through Even's own tools, not Docker. For Render or Railway, deploy `server/` from its Dockerfile or as a plain Node app; the tone service needs more memory than free tiers give, so run it on a laptop with a tunnel or on a Vultr instance and set `TONE_URL`.

Spec: `MVP_IMPLEMENTATION_SPEC.md` (v4.2).
