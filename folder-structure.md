# Asked & Answered — folder structure

```
asked-answered/
├── README.md
├── .gitignore
│
├── glasses-app/                  # A: Even Hub app (runs on the phone)
│   ├── app.json                  # manifest: g2-microphone permission, server domain
│   ├── package.json
│   ├── index.html
│   └── src/
│       ├── main.ts               # waits for the bridge, starts everything
│       ├── socket.ts             # WebSocket to server, hello/ping/reconnect
│       ├── audio.ts              # starts G2 mic, forwards audio chunks
│       ├── display.ts            # the one answer line, auto-clear
│       └── gestures.ts           # tap, double tap, long press (pause)
│
└── server/                       # C: the hub (Node + TypeScript)
    ├── package.json
    ├── tsconfig.json
    ├── .env.example              # copy to .env, never commit .env
    ├── README.md
    ├── src/
    │   ├── index.ts              # HTTP routes, /ws upgrade, reminders
    │   ├── config.ts             # reads environment variables
    │   ├── types.ts              # contract shapes shared by everyone
    │   ├── session.ts            # one phone connection
    │   ├── matcher.ts            # embeddings + yes/no double-check
    │   ├── store.ts              # Q&A records, saved to JSON
    │   ├── speech/               # B: speech module
    │   │   ├── index.ts          # createSpeechModule() + fake provider
    │   │   ├── deepgram.ts       # B adds
    │   │   └── elevenlabs.ts     # B adds
    │   └── creao/                # D: Creao module
    │       ├── index.ts          # submitClip, runSummary, handleWebhook
    │       └── client.ts         # D adds: Creao API calls
    ├── scripts/
    │   ├── fake-phone.ts         # pretends to be A's app
    │   ├── fake-script.txt       # scripted conversation for fake speech
    │   ├── seed-facts.ts         # posts sample family facts
    │   └── test-matcher.ts       # 20 matches, 10 look-alikes
    └── data/                     # store.json (gitignored)
```

## Who owns what

| Folder | Owner |
| --- | --- |
| `glasses-app/` | A: Glasses |
| `server/src/speech/` | B: Speech |
| `server/` (everything else) | C: Server and matching |
| `server/src/creao/` + the dashboard inside Creao | D: Creao |
