# Asked & Answered — Part C server

The server everything talks to: the phone socket (contract 1), the Q&A store, the repeat matcher, and the HTTP endpoints for Creao (contract 4). B's speech code and D's Creao code plug in as modules (contracts 2 and 5).

## Run it

```bash
npm install
cp .env.example .env        # fill in GEMINI_API_KEY, APP_TOKEN, FACTS_SECRET
npm run dev                 # server on :8080, restarts on save
```

In a second terminal, test the whole loop without glasses:

```bash
npm run seed-facts          # posts 3 sample caregiver facts, like D will
npm run fake-phone          # pretends to be A's app; prints what the glasses would show
```

With `SPEECH_PROVIDER=fake`, the server replays `scripts/fake-script.txt` as if people were talking. You should see the repeated lunch question answered and "Where is Mary?" answered from the family fact.

## Files

| File | Owner | What it does |
| --- | --- | --- |
| `src/index.ts` | C | HTTP routes, `/ws` upgrade with token check, heartbeat, reminders, Creao log every 5 min, scheduled summary/patterns, midnight expiry |
| `src/facts.ts` | C | Fact validation and saving (shared by `/facts` and Creao runs); `creaoStore` for D's router |
| `src/session.ts` | C | One phone connection: messages, pause/resume, 60-second audio buffer for tone, matching, saving pairs, idle close |
| `src/matcher.ts` | C | Embeddings + cosine + yes/no double-check; any failure returns nothing |
| `src/store.ts` | C | Q&A records and cached embeddings, saved to a JSON file |
| `src/types.ts` | all | Contract shapes |
| `src/speech/index.ts` | **B** | ElevenLabs live speech, Deepgram fallback, fake provider; [Role B setup and calibration](src/speech/README.md) |
| `src/creao/index.ts` | **D** | Creao module; ships as logging stubs. D replaces them |
| `src/emotion/index.ts` | C | Cuts each wearer question's audio, sends it to `tone-service/`, stores the tone record |
| `src/wav.ts` | C | WAV header and the 60-second rolling audio buffer |

## Endpoints

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | none | Status, session count, which matcher is active |
| `WS /ws?token=APP_TOKEN` | token | Phone socket, contract 1 |
| `POST /facts` | `Bearer FACTS_SECRET` | Add or replace caregiver facts and reminders |
| `DELETE /facts/:id` | `Bearer FACTS_SECRET` | Remove one fact |
| `GET /qa/today` | `Bearer FACTS_SECRET` | Today's spoken pairs for the dashboard |
| `GET /log/today` | `Bearer FACTS_SECRET` | Transcript, every question with its tone, repeated questions with counts and worry per ask, contradictions (spoken answer vs family fact), reminders with `scheduled`/`sent`/`missed` |
| `GET`/`POST /settings` | `Bearer FACTS_SECRET` | `{"toneAnalysis": true\|false}` |
| `POST /creao/webhook?s=WEBHOOK_SECRET` | secret in the URL (`webhookUrl()` in `config.ts`), separate from `FACTS_SECRET`; D's handler also verifies run IDs | Creao run results |
| `POST /creao/summary` | `Bearer FACTS_SECRET` | Trigger the end-of-day summary by hand in the demo |
| `POST /debug/match` | `Bearer FACTS_SECRET` | `{"question":"..."}` → what the matcher would answer, with its score. Not served when `NODE_ENV=production` (the Dockerfile sets it) |

## Background jobs

- **Idle check:** a phone that sends nothing (no audio, no ping) for 45 s is disconnected, which closes its speech stream.
- **Creao log:** every 5 minutes, `submitLog` with new transcript, pairs, questions and tone (window ends 15 s ago).
- **Summary and patterns:** `runSummary` at `SUMMARY_AT` (20:00) and `runPatterns` at `PATTERNS_AT` (23:30), wearer's local time, once a day, within 15 minutes after the time (a server started later doesn't fire them). The window doesn't cross midnight, so keep both at 23:45 or earlier. A missed or failed run isn't retried; use `POST /creao/summary`.
- **Reminders:** sent to listening phones within 5 minutes of `remindAt`, otherwise marked `missed`; the status shows in `/log/today`. No backlog after a reconnect.
- **Tone probe:** every 30 s until the tone service answers with its model loaded.

## Tuning the matcher

```bash
npm run test:matcher                       # 20 should-match, 10 look-alikes
MATCH_THRESHOLD=0.85 npm run test:matcher  # try another threshold
```

Goal: **0 wrong matches**, then as many repeats caught as possible. Set the winning value as `MATCH_THRESHOLD`. Every live match is logged as `[match ...]` with its score and decision, which is what you tune from at 3 AM.

Without `GEMINI_API_KEY` the server uses a crude local matcher so it still runs; it is for testing plumbing only and does make wrong matches. Always demo with the key.

`EMBED_MODEL` and `VERIFY_MODEL` default to `gemini-embedding-001` and `gemini-2.5-flash`. If Google renames them, change the env vars, not the code.

### StepFun for the yes/no checks

The yes/no checks (same question? a real reply? do two answers agree?) can run on StepFun instead of Gemini: set `VERIFY_PROVIDER=stepfun`, `STEPFUN_API_KEY` and `STEPFUN_MODEL` (a fast chat model from platform.stepfun.com; `STEPFUN_BASE_URL` is `api.stepfun.ai` for international keys, `api.stepfun.com` for China-region keys). Embeddings stay on Gemini, so `GEMINI_API_KEY` is still required.

Switch only after comparing: run `npm run test:matcher`, then `VERIFY_PROVIDER=stepfun npm run test:matcher`. Keep StepFun only if wrong matches stay at 0 and the ms per question leaves room under the 2-second cap. `/health` shows which provider is active (`verify`).

## Deploy (Render or Railway)

- From the Dockerfile, or as a plain Node app (build: `npm ci`, start: `npm start`, Node 22.9+). Set `NODE_ENV=production` on a plain Node deploy.
- Set every variable from `.env.example` in the dashboard. `PUBLIC_URL` is the service's HTTPS URL.
- Both platforms support WebSockets on the same port. Give A the `wss://` URL and `APP_TOKEN`, and D the URL, `FACTS_SECRET` and the webhook URL from `webhookUrl()` (it contains `WEBHOOK_SECRET`).
- Free tiers sleep when idle: hit `/health` before the demo, and know the JSON file store resets on redeploy (fine for a hackathon; re-run `seed-facts`).
