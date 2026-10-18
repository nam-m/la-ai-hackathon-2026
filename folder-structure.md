# Asked & Answered — folder structure

```
asked-answered/
|-- README.md
|-- MVP_IMPLEMENTATION_SPEC.md        # spec v4.2
|-- folder-structure.md               # this file
|-- docker-compose.yml                # runs server + tone-service together
|-- .env.example                      # copy to .env: TONE_SECRET, tone settings, host ports for compose
|-- .gitignore
|
|-- glasses-app/                      # A: Even Hub app (runs on the phone, not in Docker)
|   |-- app.json                      # manifest: g2-microphone permission, server domain
|   |-- package.json
|   |-- index.html
|   `-- src/
|       |-- main.ts                   # waits for the bridge, starts everything
|       |-- socket.ts                 # WebSocket to server, hello/ping/reconnect
|       |-- audio.ts                  # starts G2 mic, forwards audio chunks
|       |-- display.ts                # the one answer line, auto-clear
|       `-- gestures.ts               # tap, swipe up, long press, double tap exit
|
|-- server/                           # C: the hub (Node + TypeScript), in Docker
|   |-- Dockerfile
|   |-- .dockerignore
|   |-- package.json
|   |-- package-lock.json
|   |-- tsconfig.json
|   |-- .env.example                  # copy to .env, never commit .env
|   |-- README.md
|   |-- src/
|   |   |-- index.ts                  # HTTP routes, /ws upgrade, reminders, Creao log every 5 min
|   |   |-- config.ts                 # reads environment variables
|   |   |-- types.ts                  # contract shapes shared by everyone
|   |   |-- session.ts                # one phone connection, audio buffer, questions
|   |   |-- matcher.ts                # embeddings + yes/no double-check
|   |   |-- store.ts                  # Q&A, facts, transcript, questions, tone, settings, Creao results
|   |   |-- facts.ts                  # fact validation + saving; creaoStore for D's router
|   |   |-- wav.ts                    # WAV header + 60-second audio buffer
|   |   |-- speech/                   # B: speech module
|   |   |   |-- index.ts              # createSpeechModule() + fake provider
|   |   |   |-- elevenlabs.ts         # B: live Scribe v2 Realtime adapter
|   |   |   |-- deepgram.ts           # B: Nova-3 fallback adapter
|   |   |   |-- README.md             # B: setup, calibration and hardware acceptance
|   |   |   `-- *.ts                  # B: audio clock, roles/types, config, fake replay and tools
|   |   |-- creao/                    # D: Creao module
|   |   |   |-- index.ts              # submitLog, submitClip, runSummary, handleWebhook
|   |   |   `-- client.ts             # D adds: Creao API calls
|   |   `-- emotion/                  # C: tone of voice
|   |       `-- index.ts              # cuts question audio, calls tone-service, circuit breaker
|   |-- scripts/
|   |   |-- fake-phone.ts             # pretends to be A's app (FAKE_PHONE_NOISE=1 for tone)
|   |   |-- fake-script.txt           # scripted conversation for fake speech
|   |   |-- seed-facts.ts             # posts sample family facts
|   |   |-- test-matcher.ts           # 20 matches, 10 look-alikes
|   |   |-- speech-demo.ts            # B: short, offline contract demo
|   |   |-- calibrate-speech.ts       # B: real-G2 recording calibration
|   |   |-- replay-speech.ts          # B: live provider replay of a consented recording
|   |   |-- speech-record.ts          # B: local transcription-only microphone test
|   |   |-- recorder-server.ts        # B: loopback recorder HTTP harness
|   |   `-- recorder-web/             # B: browser recorder assets
|   |-- test/                        # automated speech, provider and server contract tests
|   |-- examples/                    # calibration manifest template
|   `-- data/                         # store.json (gitignored; a volume in Docker)
|
`-- tone-service/                     # C: emotion2vec+ (Python), in Docker
    |-- Dockerfile
    |-- .dockerignore
    |-- app.py                        # POST /tone, GET /health
    |-- requirements.txt
    `-- README.md
```

## Who owns what

| Folder | Owner | Runs where |
| --- | --- | --- |
| `glasses-app/` | A: Glasses | Phone, through Even's tools |
| `server/src/speech/` | B: Speech | Inside the server |
| `server/` (everything else) and `tone-service/` | C: Server, matching, tone | Docker, or Render/Railway + laptop/Vultr |
| `server/src/creao/` + the dashboard and agents inside Creao | D: Creao | Inside the server + Creao's cloud |

## Not in the repo

- The Creao app, dashboard and agents: built inside Creao.
- External APIs the server calls: ElevenLabs (transcription), Gemini (matching), Creao (agents).
