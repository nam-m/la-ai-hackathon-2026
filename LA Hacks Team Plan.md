# Asked & Answered — LA Hacks Team Plan

Oct 17, 2026 · @H

## The pitch

We're building Even G2 glasses that quietly answer the questions a person with early dementia keeps repeating, using answers their family already gave.

- **The problem:** people with early dementia often ask the same question many times a day. Each repeat is distressing for them and exhausting for the people who love them.
- **The user:** an older adult with early-stage memory loss who lives with or near family.
- **What it does:** when the wearer asks a question they already asked, the glasses show the earlier answer in one line, with who said it and when: *Lunch is at 12, Sarah, 10:40 AM.* Questions nobody answered aloud fall back to facts the family entered in a Creao caregiver dashboard.
- **Why G2:** the answer appears privately, with no phone and no one having to repeat themselves. The display stays blank until it's needed, which is Even's Quiet Tech brief.

**Prizes we're targeting:** Even Realities (Made for G2, Originality, User Experience, Technical Execution), Creao AI Best Team Empowerment (the family care team), and the Beyond the Digital track.

## How it works

Two paths: a fast one for live answers that skips Creao, and a slow one where Creao does the background work. Creao calls are asynchronous agent runs with no promised speed, so they can't sit in the live loop.

&#91;embedded content: system architecture · 5 parts\]

**The fast path (live answers):**

1. **Listen:** the phone app records from the G2 mics (raw 16 kHz audio chunks) and streams speech to a speech-to-text service through our server.
2. **Capture:** when the wearer asks a question, the server saves the next thing someone else says as its answer, with speaker and time.
3. **Match:** on each new question, the server checks whether it means the same as an earlier one ("When's lunch?" = "What time do we eat?").
4. **Answer:** match found, the server returns the stored answer word for word. No spoken answer: it checks the caregiver facts synced from Creao. Nothing reliable: it returns nothing.
5. **Show:** the phone app puts one line on the glasses: *Lunch is at 12, Sarah, 10:40 AM.*

**The slow path (Creao, in the background):**

- Every few minutes the server uploads recent audio to a Creao workspace and starts an agent run. Creao returns a speaker-labeled transcript that becomes the day's log.
- The family edits facts in the Creao dashboard; the server pulls them in.
- At the end of the day Creao writes the summary: which questions repeated, how often, what to flag.
- Results come back to the server by webhook.

The server exists because Creao and speech-to-text API keys are secrets and can't live in the phone app. A small Node server on Render or Railway is enough.

### Creao agents

Three agents behind one Creao app. The family dashboard is the app's own screen on top of them, not a separate agent.

| Agent | Runs | What it does | Priority |
| --- | --- | --- | --- |
| Log and summary | Every 5 min, plus 8 PM | Turns audio clips into a speaker-labeled log; writes the end-of-day summary for the family | Must have |
| Patterns | Nightly | Compares days: more repeats, new worries, confusion at certain times of day. Flags changes to the family; never diagnoses | Should have |
| Reminders | On the family's schedule | Family sets reminders in the dashboard ("Pills at 2 PM"); the server shows them on the glasses at the right time | Stretch |

Each agent is a scheduled Creao run that reports back to our server by webhook. That gives the Creao pitch a care team of agents working for the family.

### Transcription

A 30-minute loudness test at 6 PM picks the service. The G2's mics sit next to the wearer's mouth, so their voice should be much louder than anyone else's.

|  | ElevenLabs Scribe v2 Realtime | Deepgram Nova-3 |
| --- | --- | --- |
| Pick it if | Loudness clearly separates wearer from others | Loudness gap is unclear |
| Speed | About 150 ms | Under 300 ms |
| Live speaker labels | No (batch model only) | Yes |
| Glasses show | *Lunch is at 12 (told you at 10:40)* | *Lunch is at 12, Sarah, 10:40* |
| Bonus | MLH Best Use of ElevenLabs prize | $200 free credits, no card |

Either way the answer reaches the glasses about 1 to 2 seconds after the question ends; waiting for the sentence to finish is the biggest delay. The server holds the key and streams the G2's raw 16 kHz mono audio to the chosen service. The G2 records from its mics or the phone's, one source at a time, and has no wearer-only mode.

Sources: [Even device APIs](https://hub.evenrealities.com/docs/build/device-apis) · [ElevenLabs speech to text](https://elevenlabs.io/docs/overview/capabilities/speech-to-text.mdx) · [ElevenLabs realtime](https://elevenlabs.io/realtime-speech-to-text-api) · [Deepgram streaming latency](https://developers.deepgram.com/docs/measuring-streaming-latency.mdx) · [Deepgram live API](https://developers.deepgram.com/reference/listen-live)

## Trust and safety rules

A wrong answer to someone with dementia is worse than no answer, so these rules are non-negotiable and go in the pitch.

1. **The AI never writes answers.** It only decides whether a new question matches an old one. What the glasses show is word for word what a real person said or what the family typed in.
2. **Every answer shows who and when.** A familiar name and a time make the answer believable and let the wearer judge if it's stale.
3. **When unsure, show nothing.** Use a high match threshold. A missed repeat costs little; a wrong answer costs trust.
4. **Old answers expire.** Today's answers only, unless the family marked a fact as standing ("You live at…").
5. **Consent first.** The app is set up by the family with the wearer, and everyone in the demo knows they're being transcribed. Audio sent to Creao is processed by OpenAI or Google, so real users would get consent and data controls.

## Roles

One owner per layer, so nobody blocks anybody. Replace the role names with your names.

| Role | Owns | Main deliverable |
| --- | --- | --- |
| A: Glasses | Even Hub app on the phone, G2 display, touch input, packaging the Beta | One clean line on the G2 within \~1 s of a match |
| B: Speech | Loudness test, live speech-to-text, wearer vs. others, catching Q&A pairs | A stream of tagged questions and answers |
| C: Server and matching | Our server, the Q&A store, repeat matching with the yes/no double-check, answer delivery | Correct answers to repeats in under 2 s, nothing for look-alikes |
| D: Creao | Creao app and dashboard, the three agents, webhook handler, facts to the server | Family facts reach the glasses; dashboard shows log and summary |

No one owns product work during the build. Pitch, demo, judge answers and Devpost happen together from 11 AM Sunday.

A and B sit together for the loudness test; B and C agree on the speech module's interface by 8 PM; C and D agree on the webhook and facts endpoints by 7 PM. The build guide has each person's steps.

## Timeline

Feature freeze is 11 AM Sunday (moved from 9:30 AM; the steps after it have no fixed times, we do them as we go); submissions close at noon. Every phase ends with something that works end to end.

1. **Sat 4–8 PM: Hello, glasses.** Template running on the G2, loudness test done and transcription service chosen by 6 PM, live transcript reaching the server, our server answering a test call from the phone. The Even table closes at 8 PM, so solve hardware problems before then.
2. **Sat 8 PM–2 AM: The core loop.** Q&A capture, repeat matching, the one-line answer on the glasses. Milestone: a repeated question shows its earlier answer.
3. **Sun 2–6 AM: The family side.** Log and summary agent running; caregiver facts sync from Creao to the server and reach the glasses. Sleep in shifts.
4. **Sun 6–11 AM: Polish.** Patterns agent, timing, display wording, edge cases (no answer, stale answer, noise).
5. **Sun 11 AM–12 PM: Ship, all four together.** Package and upload the EvenHub Beta, install it from Beta and test, finish Devpost, rehearse the demo three times.

## Tasks

Tick tasks off as you finish them. Times are deadlines, not start times. Sub-tasks are the steps; the parent is done when they all are.

### Everyone

- [ ] Kickoff: read this plan, confirm roles, Sat 5 PM
- [ ] Agree on message formats, Sat 5:30 PM
  - [ ] Phone to server: audio chunks over a WebSocket
  - [ ] Server to phone: answer text, speaker (if known), time, or nothing
  - [ ] Server and Creao: Q&A pair, caregiver fact, summary
- [ ] Shared repo with an .env template; real keys never committed, Sat 5:30 PM
- [ ] Standups at Sat 8 PM, Sun 2 AM and Sun 9 AM
- [ ] Sleep in shifts; at least two people awake at all times

### A: Glasses

- [ ] Device setup, Sat 5:30 PM
  - [ ] Pick up the G2 (bring ID), pair it, update firmware
  - [ ] Enable developer mode; same account in the phone app and the portal
  - [ ] Install Node, the Even CLI and the simulator
- [ ] Hello, glasses, Sat 6:30 PM
  - [ ] Run the asr template; scan the QR using the laptop's LAN IP, not localhost
  - [ ] Show "hello" on the G2 and confirm a tap event arrives
  - [ ] If venue Wi-Fi blocks it, switch to a phone hotspot
- [ ] Help B run the loudness test with the real G2, Sat 6 PM
- [ ] Mic to server, Sat 8 PM
  - [ ] Start the glasses mic and receive audio chunks
  - [ ] Open a WebSocket to our server and forward the chunks
  - [ ] Reconnect automatically if the connection drops
- [ ] Answer display, Sat 11 PM
  - [ ] One line: answer, speaker if known, time
  - [ ] Test long answers on the real display and trim them
  - [ ] Clear the line after about 8 seconds
- [ ] Gestures, Sun 2 AM
  - [ ] Tap: dismiss
  - [ ] Double tap: show the last answer again
  - [ ] Long press: pause or resume listening, show "Paused"
- [ ] Robustness, Sun 8 AM
  - [ ] Lock the phone for 5 minutes, unlock: listening restarts
  - [ ] Denied mic permission shows a clear message
  - [ ] Double-tap exit from the root page works
- [ ] Ship the Beta
  - [ ] Package the .ehpk and upload it; Beta group with the phone account
  - [ ] Install from Beta (Me, then Beta tester) and rerun the whole demo

### B: Speech

- [ ] Loudness test, which decides the transcription service, Sat 6 PM
  - [ ] Record the wearer and a teammate across a table through the G2 mics
  - [ ] Compare volume per sentence
  - [ ] Clear gap: ElevenLabs Scribe v2 Realtime. Unclear: Deepgram Nova-3
  - [ ] Tell the team which one
- [ ] Account and API key for the chosen service, stored on the server only, Sat 6:30 PM
- [ ] Live transcript on the server, Sat 8 PM
  - [ ] Open a streaming connection; declare raw 16 kHz mono 16-bit audio
  - [ ] Regroup G2 chunks to the size the service recommends
  - [ ] Log finished sentences with timestamps
- [ ] Tell the wearer from others, Sat 11 PM
  - [ ] ElevenLabs: a loudness threshold per sentence
  - [ ] Deepgram: speaker labels, a setup sentence to find the wearer's label, loudness as tiebreaker
  - [ ] Deepgram only: map speaker labels to family names at setup
- [ ] Capture Q&A pairs, Sun 1 AM
  - [ ] Detect the wearer's questions
  - [ ] The next sentence from someone else within 30 seconds is the answer
  - [ ] Save the pair on the server
- [ ] Skip silent chunks so only speech is sent, Sun 3 AM
- [ ] Measure question end to glasses; target 2 seconds or less, Sun 6 AM
- [ ] Noisy room test with three people talking, Sun 8 AM

### C: Server and matching

- [ ] Server skeleton, Sat 6:30 PM
  - [ ] Node server on Render or Railway with an HTTPS URL
  - [ ] API keys stored as environment secrets
  - [ ] WebSocket endpoint for the phone, webhook stub for D, health check; CORS allows the app
  - [ ] Post the URL in the team chat
- [ ] Plug in B's speech module behind an agreed interface, Sat 8 PM
- [ ] Q&A store: pairs with speaker, time and date; today only unless marked standing, Sat 9 PM
- [ ] Test set: 20 pairs that should match, 10 look-alikes that shouldn't, Sat 10 PM
- [ ] Repeat matching, Sun 1 AM
  - [ ] Compare questions by meaning (embeddings)
  - [ ] Strict threshold tuned on the test set
  - [ ] Yes/no double-check with a fast model before sending
  - [ ] Send the newest stored answer word for word, or nothing
- [ ] Answer delivery, clear and pause handling, Sun 2 AM
- [ ] Facts endpoint for D, protected by a shared secret, Sun 3 AM
- [ ] Reliability: store survives restarts, logs every match score and decision, Sun 8 AM

### D: Creao

- [ ] Creao developer API key; confirm runs, webhooks, file uploads and getting app data out at the Creao table, Sat 6 PM
- [ ] Test run with a webhook to C's stub; time it and note it under Open questions, Sat 7 PM
- [ ] Webhook handler in C's server: verify, route results by run type, Sat 9 PM
- [ ] Creao app and dashboard: today's plan, visitors, standing facts, Q&A log, summary, Sat 11 PM
- [ ] Caregiver facts reach C's store through the facts endpoint, Sun 1 AM
- [ ] Log and summary agent, Sun 4 AM
  - [ ] Wrap 5-minute audio clips as WAV and upload to a Creao workspace
  - [ ] Start a transcript run; save the result to the log
  - [ ] End-of-day summary run, triggered by hand for the demo
- [ ] Today's Q&A pairs shown on the dashboard, Sun 5 AM
- [ ] Patterns agent (should have), Sun 7 AM
- [ ] Reminders agent (stretch, only if everything else works), Sun 9 AM

### Together, Sun 11 AM to noon

- [ ] A packages and uploads the Beta first, then joins
- [ ] Bug bash: everyone runs the full demo on the real G2
- [ ] Pitch with a named user
- [ ] Demo setup: D enters the caregiver facts; assign Grandma, Sarah and narrator
- [ ] Everyone learns the four judge answers (build guide, Together at the end)
- [ ] Devpost: B story, C diagram and screenshots, A backup video, D selects challenges
- [ ] Rehearse the demo three times, 11:45 AM
- [ ] Return the G2 after judging

## Open questions and fallbacks

Resolve the first two today; the plan changes if either answer is no.

| Question | Ask | If the answer is bad |
| --- | --- | --- |
| Does loudness separate the wearer from others? | B's loudness test, Sat 6 PM | Use Deepgram and its speaker labels |
| Can our server start Creao runs and get webhooks back? | Creao table, Sat 5 PM | Trigger the Creao agents by hand for the demo and show their results in the dashboard |
| How long does one Creao run take? | Time C's first test run | Already handled: Creao stays out of the live path, so only the log updates slower |
| Does the four-mic array focus on the wearer? Can glasses and phone mics record at once? | Even table | Docs say one source at a time; rely on loudness or speaker labels |
| Do the G2 mics pick up people across a table? | B's loudness test | Switch to the phone's mic on the table and use Deepgram speaker labels |
| Does venue Wi-Fi block phone-to-laptop testing? | First QR test | Use a phone hotspot for laptop and phone |

## Demo and submission

The demo is 90 seconds and ends with the judge wearing the glasses.

1. **Set the scene (15 s):** "Grandma asks what time lunch is. Sarah tells her noon." Two teammates act it out.
2. **The repeat (20 s):** a minute of chatter, then Grandma asks again. *Lunch is at 12, Sarah, 10:40 AM* appears on the glasses. Show it on the phone mirror too.
3. **Judge's turn (30 s):** hand the judge the G2. They ask "Where's Mary?" and see the fact the family pre-entered.
4. **The family side (15 s):** show the dashboard and the daily summary of repeated questions.
5. **Close (10 s):** "The AI never invents an answer. It only repeats what someone who loves you already said."

**Before the noon deadline:**

- [ ] Project uses the Even SDK and was tested on a real G2
- [ ] Final .ehpk uploaded and installed from EvenHub Beta
- [ ] LA Hacks Devpost submitted, with Even Realities and Creao challenges selected
- [ ] Team at the table, glasses charged, phone charged
- [ ] G2 returned before leaving
