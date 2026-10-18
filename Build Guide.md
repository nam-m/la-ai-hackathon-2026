# Asked & Answered — Build Guide

Oct 17, 2026 · @H

One part per team member: what you build, what you receive and send, the steps in order, and when you're done. The team plan has the schedule and task checklist; this doc has the how.

## API contracts

Each part talks to the others only through these contracts. Build against them, ship a stub first so nobody waits (last table), and change a contract only with the other side's OK, bumping `v`.

| From and to | Channel | Contract |
| --- | --- | --- |
| A and C | WebSocket `/ws` | 1. Phone socket |
| C hosts B | TypeScript module `server/speech` | 2. Speech module |
| B to transcription service | Provider WebSocket | 3. Transcription service |
| D to C | HTTP on C's server | 4. Server endpoints for Creao |
| C hosts D | TypeScript module `server/creao` | 5. Creao module |
| D to Creao | Creao API | 6. Creao API |

### 1. Phone socket (A and C)

URL: `wss://<server>/ws?token=<APP_TOKEN>`. The token only keeps random clients out; it is not a real secret.

**Phone to server.** Audio goes as binary frames: raw PCM, signed 16-bit little-endian, 16 kHz, mono, sent as received from the G2. Everything else is JSON text frames:

```json
{"v":1,"type":"hello","session":"demo-1","source":"glasses"}
{"v":1,"type":"control","action":"pause"}
{"v":1,"type":"control","action":"resume"}
{"v":1,"type":"ping"}
```

**Server to phone:**

```json
{"v":1,"type":"answer","id":"qa_17","text":"Lunch is at noon.","speaker":"Sarah","at":"10:40 AM","source":"spoken"}
{"v":1,"type":"clear"}
{"v":1,"type":"status","text":"Listening"}
{"v":1,"type":"pong"}
{"v":1,"type":"error","code":"stt_down","message":"Transcription unavailable"}
```

**Rules**

- The phone sends `hello` first after every connect; the server replies with status `Listening`.
- `speaker` is null when there are no names; the phone then shows *text (told you at `at`)*. `source` is `spoken` or `family`.
- `at` is already formatted in the wearer's time zone; the phone shows it as is.
- At most one `answer` per question. `error` codes: `stt_down`, `bad_audio`, `unauthorized`.
- The phone pings every 15 s and reconnects with backoff of 1, 2, 4, then 10 s.
- The server closes a connection that sends nothing (no audio, no ping) for 45 s. After reconnecting, the phone sends `hello`, then `pause` again if the wearer had paused.

### 2. Speech module (B builds, C hosts)

File `server/speech/index.ts`. One module per phone session.

```typescript
export type Utterance = {
  id: string
  text: string
  startMs: number   // ms from the session's first audio byte, counting every byte passed to pushAudio
  endMs: number
  rmsDb: number
  speaker: string | null   // provider label; null with ElevenLabs
  name: string | null      // family name if known
  role: 'wearer' | 'other' | 'unknown'   // B decides; unknown/overlapping speech is never a question or answer
  isWearer: boolean        // same as role === 'wearer'
}

export type QAPair = { question: Utterance; answer: Utterance }

export interface SpeechModule {
  pushAudio(pcm: Uint8Array): void
  pause(): void
  resume(): void
  close(): Promise<void>
}

export function createSpeechModule(opts: {
  provider: 'elevenlabs' | 'deepgram' | 'fake'
  apiKey: string
  onUtterance(u: Utterance): void
  onWearerQuestion(q: Utterance): void   // as soon as the question is final
  onPair(p: QAPair): void                // when its answer arrives, within 30 s
  onError(e: Error): void
}): SpeechModule
```

**Rules:** `onWearerQuestion` fires before the answer arrives so C can match immediately. Only `role: 'wearer'` questions and `role: 'other'` answers form pairs. Call `onPair` for **every** `other` utterance within 30 s of the question, not just the first: C checks them in spoken order, saves the earliest one that actually replies to the question and ignores the rest. A new wearer question closes the previous window, so report candidates in the order they were spoken. The server cuts tone audio from its own buffer by `startMs`/`endMs`, so if you skip silent chunks, keep counting their bytes. `fake` replays scripted lines from a text file on a timer.

### 3. Transcription service (B, external)

**Deepgram:** connect to `wss://api.deepgram.com/v1/listen` with `model=nova-3`, `encoding=linear16`, `sample_rate=16000`, `channels=1`, `diarize=true`, `punctuate=true` (off by default; question detection needs the "?"), `interim_results=true`, `endpointing=300` (a starting value to tune), and the header `Authorization: Token <key>`. Send 20 to 100 ms per message, which is 640 to 3,200 bytes at this format. Use results marked final, joining `is_final` pieces until `speech_final` (or `UtteranceEnd`): one sentence can arrive in several pieces.

**ElevenLabs:** Scribe v2 Realtime through `@elevenlabs/elevenlabs-js` (`speechToText.realtime.connect`). Set 16 kHz PCM input and chunk size from their realtime streaming guide.

### 4. Server endpoints for Creao (D calls, C hosts)

`/facts` and `/qa/today` use `Authorization: Bearer <FACTS_SECRET>`. Creao can't set that header, so the webhook carries a separate secret in its URL: `POST /creao/webhook?s=<WEBHOOK_SECRET>` (`webhookUrl()` in `server/src/config.ts` builds it).

**`POST /facts`** adds or replaces facts by `id`:

```json
{"v":1,"facts":[{"id":"fact_3","question":"Where is Mary?","answer":"Mary is at the store, back by 3.","answeredBy":"Sarah","standing":false,"remindAt":null}]}
```

Returns `200 {"stored":1}`, `400` for a bad body, `401` for a bad secret. Facts without `standing: true` expire at the wearer's midnight, so re-post them each day. For a reminder (stretch), set `remindAt` to an ISO time and `question` to null. **`DELETE /facts/:id`** removes one.

**`GET /qa/today`** returns `{"v":1,"pairs":[ ...Q&A records ]}` for the dashboard.

`POST /facts`, `DELETE /facts/:id` and `GET /qa/today` stay at these root URLs in C's `index.ts`. D's router is mounted with `app.use('/creao', ...)` and serves only `/creao/webhook`; mounting `/facts` there would change its URL to `/creao/facts`.

**`POST /creao/webhook`** receives whatever Creao sends when a run finishes. It replies `200` at once and processes afterwards. It only accepts run IDs the server started; the server keeps a map of run ID to kind (`log`, `summary`, `facts`, `patterns`) to route each result.

### 5. Creao module (D builds, C hosts)

File `server/creao/index.ts`. Nothing here is ever awaited in the live path.

```typescript
export async function submitLog(batch: { fromIso: string; toIso: string; transcript: unknown[]; pairs: unknown[]; events: unknown[]; tones: unknown[] }): Promise<string> // run ID
export async function submitClip(wav: Buffer, range: { fromIso: string; toIso: string }): Promise<string> // optional, unused by default
export async function runSummary(dateIso: string): Promise<string>
export async function runPatterns(dateIso: string): Promise<string>
export async function handleWebhook(body: unknown): Promise<void>
```

Every 5 minutes C calls `submitLog` with the new transcript lines, Q&A pairs, question events and tone records (spec v4.1 section 8; the window ends 15 s ago so in-flight tone results aren't missed). C's server also starts `runSummary` at 20:00 and `runPatterns` at 23:30 local time (`SUMMARY_AT`, `PATTERNS_AT`), once per day. For D's router, `creaoStore` in `server/src/facts.ts` implements `CreaoStore` and `runRegistry` in `server/src/store.ts` implements `RunKindRegistry`.

### 6. Creao API (D, external; confirm at the Creao table)

From Creao's developer docs as shared with us, base URL `https://developer.creao.ai`, key `cr_sk_...` on the server only:

- `POST /v1/workspaces/{workspace_id}/files`: multipart upload of the audio clip
- `POST /v1/runs` with `agent_id`, `input`, `workspace_id`, `webhook_url`: returns `202` and a `run_id`
- `GET /v1/runs/{run_id}`: status, if a webhook is late
- Errors to handle: `UNSUPPORTED_FILE_TYPE`, `FILE_TOO_LARGE`, `RATE_LIMITED`

### Q&A record

C's store keeps one shape for spoken pairs and family facts:

```json
{"id":"qa_17","question":"What time is lunch?","answer":"Lunch is at noon.","askedAt":"2026-10-18T10:39:52-07:00","answeredAt":"2026-10-18T10:40:03-07:00","answeredBy":"Sarah","source":"spoken","standing":false}
```

Family facts use `source: "family"`, and `standing: true` for facts that never expire.

### Timing budget

| Step | Owner | Budget |
| --- | --- | --- |
| Question ends to final transcript | B | 1 s |
| Embedding, match and yes/no check | C | 0.8 s |
| Server to glasses display | A | 0.2 s |
| **Total** |  | **2 s** |

Creao has no budget because it is never in this path.

### Stubs first (by 7 PM)

| Part | Stub the others build against |
| --- | --- |
| A | A test page that sends a recorded WAV to `/ws` |
| B | `provider: 'fake'` replaying scripted lines |
| C | `/ws` that replies to `hello` and sends a fake answer every 20 s; `/facts` that stores in memory |
| D | `server/creao` functions that only log; a script that posts three sample facts |

## Part 1 — A: Glasses lead

You build the Even Hub app: a TypeScript web app that runs on the phone, captures the G2 mic, forwards audio to the server, and shows the answer line on the glasses.

**You receive:** answer, clear and status messages from the server. **You send:** audio frames and pause/resume controls.

**Steps**

1. **Setup (by 5:30 PM).** Pick up the G2 with ID, pair it, update firmware, turn on developer mode. Use the same account in the phone app and the developer portal. Install Node, the Even CLI and the simulator.
2. **Hello, glasses (by 6:30 PM).** Start from the official **asr** template. Run the dev server, generate the QR with your laptop's LAN IP (not localhost), scan it in the phone app. Change the text to "hello" and confirm a tap reaches your code. Blocked by venue Wi-Fi? Put laptop and phone on a phone hotspot.
3. **Loudness test with B (6 PM).** Give B a quick way to record from the glasses mic so the test uses the real hardware.
4. **Mic to server (by 8 PM).** Create the startup page container first (the glasses mic requires it), then start recording and forward each chunk:

```typescript
const bridge = await waitForEvenAppBridge()
const ws = new WebSocket('wss://<server>/ws')
ws.binaryType = 'arraybuffer'
// create the startup page container first (see the template)
await bridge.audioControl(true, AudioInputSource.Glasses)
bridge.onEvenHubEvent(event => {
  const audio = event.audioEvent
  if (audio && ws.readyState === WebSocket.OPEN) ws.send(audio.audioPcm)
})
```

Reconnect the WebSocket with a short backoff if it drops.

5. **Answer display (by 11 PM).** One text container showing `text, speaker, at`, or `text (told you at <at>)` when `speaker` is null. Test long answers on the real display and trim them. Clear after about 8 seconds or on a `clear` message.
6. **Gestures (by Sun 2 AM).** Give the text container event capture. Click = dismiss. Double click = show the last answer again. Long press (arrives on `event.sysEvent`) = send pause or resume and show "Paused" or nothing.
7. **Robustness (by Sun 8 AM).** Lock the phone for 5 minutes and unlock: recording must restart. Denied mic permission shows a clear message. Double-tap exit from the root page works.
8. **Ship (by Sun 11 AM).** Declare `g2-microphone` and the server's domain in the manifest. Package the .ehpk, upload it, push to a Beta group with your phone's account, install it from Me, then Beta tester, and run the full demo on that build.

**Done when:** a repeated question on the real G2 shows its earlier answer, gestures work, and the installed Beta survives a phone lock.

**Watch out:** network calls need both the manifest whitelist and CORS on the server (tell C). The SDK has no fonts, colors or animations, so keep the line short. Test on the real display early, not just the simulator.

Docs: [Device APIs](https://hub.evenrealities.com/docs/build/device-apis) · [LA Hacks starter pack](https://evenrealities-lahacks.vercel.app/starterpack)

## Part 2 — B: Speech lead

You build the server's speech module: it turns the audio stream into sentences, decides who said each one, and saves question-and-answer pairs. It lives in C's server, as its own file.

**You receive:** binary audio frames from the phone (16 kHz, 16-bit, mono). **You produce:** utterances, wearer questions and Q&A pairs through the speech module's callbacks (API contract 2); C's server matches the questions and saves the pairs.

**Steps**

1. **Loudness test (by 6 PM; this decides the service).** With A, record the wearer and a teammate sitting across a table through the G2 mics. For each sentence, compute RMS volume in decibels. Do the wearer's sentences sit clearly above everyone else's, every time?
   - Clear gap: use **ElevenLabs Scribe v2 Realtime** (faster, MLH prize, no names).
   - Unclear gap: use **Deepgram Nova-3** (live speaker labels, names on the glasses).
   - Post the decision in the team chat.
2. **Key (by 6:30 PM).** Create the account, put the key in the server's environment variables, never in the app.
3. **Live transcript (by 8 PM).** Open the service's streaming WebSocket from the server and declare raw 16-bit audio at 16 kHz, mono. Regroup the G2 chunks to the size the service recommends (Deepgram: 20 to 100 ms per message). Log each finished sentence with its start and end time.
4. **Utterances (by 11 PM).** Turn every finished sentence into one object, keeping the RMS of the audio it covers:

```json
{"id":"utt_3","text":"What time is lunch?","startMs":12400,"endMs":13600,"rmsDb":-18.2,"speaker":"0","name":null,"role":"wearer","isWearer":true}
```

5. **Wearer vs. others (by 11 PM).**
   - ElevenLabs: `role` = `wearer` when RMS is above the threshold from your test, `other` when clearly below, `unknown` in between or when voices overlap.
   - Deepgram: at setup the wearer says one sentence; that speaker label is the wearer. Loudness breaks ties. Family members each say a sentence too, so their labels map to names.
6. **Q&A capture (by Sun 1 AM).** A wearer sentence ending in "?" or starting with a question word is a question. Hand it to C's matcher right away. Every `other` sentence within 30 seconds is a candidate answer: emit each with `onPair`, in the order spoken. C's server saves the earliest one that really replies to the question. A new wearer question closes the previous window.
7. **Skip silence (by Sun 3 AM).** Don't forward chunks below a quiet threshold. It saves cost and cuts noise.
8. **Measure (by Sun 6 AM).** Time from the end of the question to the line on the glasses. Target 2 seconds or less. The biggest share is the service waiting to be sure the sentence ended; shorten that setting if it's slow.
9. **Noise test (by Sun 8 AM).** Three people talking, one wearer asking. Fix whatever breaks.

**Done when:** in a noisy room, the wearer's questions and others' answers land in the store as correct pairs within 2 seconds.

**Watch out:** the wearer's own answers to someone else's question must not be saved as answers. Questions asked by others are not the wearer's questions. Keep both services' code behind one small interface so switching costs minutes, not hours.

Docs: [Deepgram live API](https://developers.deepgram.com/reference/listen-live) · [Deepgram latency](https://developers.deepgram.com/docs/measuring-streaming-latency.mdx) · [ElevenLabs speech to text](https://elevenlabs.io/docs/overview/capabilities/speech-to-text.mdx)

## Part 3 — C: Server and matching

You build the server everything talks to, the Q&A store, and the matcher that decides when a question is a repeat.

**You receive:** audio and controls from A's app, utterances and questions from B's module, caregiver facts from D. **You send:** answer, clear and status messages to A's app.

**Steps**

1. **Server skeleton (by 6:30 PM).** Node with Express and a WebSocket library, deployed on Render or Railway for a public HTTPS URL. Keys in environment variables. Endpoints: `wss://<server>/ws` for the phone, `POST /creao/webhook` as a stub for D, `GET /health`. Allow the Even app's requests through CORS. Post the URL in the team chat.
2. **Plug in B's module (by 8 PM).** Agree on a small interface: you pass audio frames in; B's module emits finished utterances and wearer questions back.
3. **Q&A store (by 9 PM).** In memory plus a JSON file or SQLite. Records follow the Q&A record in API contracts. Expire today's records at midnight; keep `standing` ones.
4. **Test questions (by 10 PM).** Write 20 pairs that should match ("When's lunch?" and "What time do we eat?") and 10 look-alikes that shouldn't ("When's lunch?" and "Where's lunch?"). You'll tune against them.
5. **Matcher (by Sun 1 AM).**
   - Embed every stored question once and each new question as it arrives. Gemini embeddings also count toward MLH's Best Use of Gemini API.
   - Compare by cosine similarity. Start the threshold high and tune with your test set: zero wrong matches matters more than catching every repeat.
   - On a close match, double-check it before sending: ask a fast model (such as Gemini Flash) only "Do these two questions ask for the same information? Answer yes or no." This catches look-alikes and adds a fraction of a second. The model only says yes or no; it never writes the answer.
   - On a yes, send the stored answer word for word in an `answer` message. Prefer the newest spoken answer, then family facts. On a no or no match, send nothing.
6. **Answer delivery and controls (by Sun 2 AM).** Push answers to the phone; send `clear` when appropriate. On `pause`, stop passing audio to B's module and send a `Paused` status.
7. **Facts endpoint for D (by Sun 3 AM).** `POST /facts`, protected by a shared secret, writes caregiver facts into the store with `source: "family"`.
8. **Reliability (by Sun 8 AM).** Store survives a server restart; clear logs for every question, match score and decision; health check passes. Sentry's tracing would also qualify for its prize.

**Done when:** a repeated question gets the right answer in under 2 seconds, look-alike questions get nothing, and family facts answer questions nobody asked aloud.

**Watch out:** never call Creao in the live path. Log every match score; it's how you'll tune the threshold at 3 AM.

## Part 4 — D: Creao lead

You build everything in Creao: the family dashboard, the agents, and the plumbing that connects Creao to C's server.

**You receive:** audio clips and today's Q&A from C's server. **You send:** caregiver facts to `POST /facts`, run results to `POST /creao/webhook`.

**Steps**

1. **Access (by 6 PM).** Get the Creao developer API key. At the Creao table, confirm how runs, webhooks and workspace file uploads work for your account, and the best way to get data out of a Creao app (the caregiver facts).
2. **Test run (by 7 PM).** From a small script, start one agent run with a `webhook_url` pointing at C's stub. Time it and write the time in the team plan's Open questions.
3. **Webhook handler (by 9 PM).** Your own file in C's server behind `POST /creao/webhook`: check the request is really from your run, then route the result by run type (log, summary, facts, patterns).
4. **Creao app and dashboard (by 11 PM).** Today's plan, who's visiting, standing facts, today's Q&A log, the end-of-day summary. You own the dashboard design.
5. **Facts to the server (by Sun 1 AM).** Use the route the Creao table recommends. Fallback: a run that returns today's facts as JSON to the webhook, triggered when the family saves. Facts land in C's store through `POST /facts`.
6. **Log and summary agent (by Sun 4 AM).** Every 5 minutes, C's server hands you buffered audio; wrap it in a WAV header, upload it to a Creao workspace, and start a run asking for a speaker-labeled transcript. Save results to the log. A separate end-of-day run writes the family summary; trigger it by hand in the demo.
7. **Q&A log on the dashboard (by Sun 5 AM).** Send today's pairs from the server into Creao so the family sees them.
8. **Patterns agent (should have, by Sun 7 AM).** Nightly run over the day's log: more repeats than usual, new worries, confusion at certain times. It flags changes for the family and never diagnoses.
9. **Reminders agent (stretch, by Sun 9 AM).** The family sets reminders in the dashboard; they reach `POST /facts` with a time, and C's server sends them to the glasses as an `answer` message at that time.

**Done when:** family facts entered in the dashboard reach the glasses, and the dashboard shows today's log and summary.

**Watch out:** Creao runs are asynchronous with no promised speed, so nothing live waits on them. Audio sent to Creao is processed by OpenAI or Google; mention it in the judge answers. Keep the Creao key on the server only.

## Together at the end

Feature freeze is **Sun 9:30 AM**. From then until noon, all four of you do the product work. A also packages the Beta first.

1. **Bug bash (9:30–10 AM).** Everyone runs the full demo on the real G2; fix only what breaks the demo.
2. **Pitch (10–10:15 AM, all).** A named user ("Rose, 78, early-stage Alzheimer's, lives with her daughter Sarah"), the problem in two sentences, a one-line pitch.
3. **Demo setup (10:15–10:45 AM).** D enters the caregiver facts the script needs ("Mary is at the store, back by 3"). Assign Grandma, Sarah and the narrator.
4. **Judge answers (all, learn them):**
   - Wrong answers? *It never writes answers; it only repeats what a person said, with who and when, and stays silent when unsure.*
   - Privacy and consent? *The family sets it up with the wearer; a long press pauses listening.*
   - Why glasses, not a phone? *No screen to find, nobody has to repeat themselves, and the answer is private.*
   - Where does the audio go? *To the transcription service and Creao's providers; real users would get consent and data controls.*
5. **Devpost (by 11:30 AM).** B writes the story; C adds the architecture diagram and screenshots; A records a backup demo video; D selects the challenges: Even Realities, Creao, plus MLH ElevenLabs or Gemini if used.
6. **Rehearse (by 11:45 AM).** Three full runs, glasses and phone charged.
7. **After judging:** return the G2 to the Even table.
