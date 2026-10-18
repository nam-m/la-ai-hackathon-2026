# Role B: speech

Implemented: server-side ElevenLabs and Deepgram streaming, raw PCM regrouping, silence filtering with preroll and VAD tail, source-time/RMS mapping, wearer classification, Deepgram setup/name mapping, question detection, 30-second Q&A capture, fake replay, calibration, and latency instrumentation. ElevenLabs is the user's selected default.

The public module is `src/speech/index.ts`; `speech/index.ts` re-exports it for the shorter path in the Build Guide. The existing callback contract is unchanged. Storage and matching belong to C: `onPair` supplies a pair to C's store and `onWearerQuestion` fires immediately for C's matcher. This package does not start C's HTTP server or implement A's glasses app.

## Run locally

Requires Node 22.9+ (Node 24 recommended). From `server/`:

```powershell
npm ci
npm run typecheck
npm test
npm run speech:demo
npm run build
node dist/scripts/speech-demo.js
```

The demo reads `scripts/fake-script.txt`, emits two questions and two verbatim pairs, and exits with failure if those counts differ. It requires no credentials and makes no API calls. A custom fake script is a tab-separated file containing `endMs`, `wearer` or `other`, family name or `-`, and transcript text; pass `fakeScriptPath` to the factory.

## Configure ElevenLabs

```powershell
Copy-Item .env.example .env
```

Set `ELEVENLABS_API_KEY` in `.env`, with `SPEECH_PROVIDER=elevenlabs`. Populate `SPEECH_WEARER_THRESHOLD_DB` from the real-microphone calibration below. Do not use the synthetic test amplitudes as a real threshold. API keys are read only on the server, sent in provider headers, and excluded from version control.

`speechOptionsFromEnv()` defaults to ElevenLabs and validates environment settings. It does not load `.env` by itself; the replay command uses Node's env-file support. C should load its server environment before calling it. A missing live API key fails creation; a missing wearer threshold allows transcripts but emits no wearer questions or pairs. No speaker label is assumed to be the wearer.

## Loudness calibration with A

1. With everyone's consent, use A's G2 microphone capture to save raw PCM or WAV files. The input must be signed 16-bit little-endian, 16 kHz, mono. Use the glasses microphone and the same gain intended for the demo, not an unrelated laptop recording.
2. Record at least five separate sentences from the wearer and five from teammates across the table, including quiet/loud speech and venue noise. Each file should contain one sentence, trimmed to its speech region; long leading/trailing silence biases whole-sentence RMS.
3. Save recordings in the gitignored `data/` directory and create a manifest like `examples/calibration-manifest.json`, with paths relative to the manifest.
4. Run the calibration command and use the resulting `providerOptions.wearerThresholdDb` as `SPEECH_WEARER_THRESHOLD_DB` only when `clearGap` is true.

```powershell
npm run speech:calibrate -- --manifest data/recordings.json --output data/calibration.json
```

The report contains each sentence's RMS, class distributions, the gap between the quietest wearer and loudest other person, and a midpoint threshold. It recommends ElevenLabs only with a minimum 6 dB gap. Overlap produces `thresholdDb: null` and recommends Deepgram. This implements the planned test; no real G2 calibration has been performed in this checkout.

## Replay a recording through the actual service

```powershell
npm run speech:replay -- data/conversation.wav
```

This sends the recording to the configured provider at real-time speed and prints timestamped utterances, wearer questions, pairs, and final-transcript latency. Only run it on recordings the participants agreed to transcribe. It accepts `.pcm` with the format above or validated PCM WAV, then sends trailing silence to finalize the last sentence. Transcripts appear on stdout; do not commit captured logs.

The replay does not connect to glasses and cannot establish question-to-display latency. Check at least two separate commits in one live ElevenLabs connection: word timestamps are interpreted as connection-relative audio time. Out-of-range or unsafe multi-sentence timestamps fail closed; a real provider replay must verify origin and drift against the recording.

## C integration

Create one module per phone session. Start its clock when audio capture begins. Pass only the binary audio frames to `pushAudio`, not a WAV header or JSON. Input chunks may split 16-bit samples; the module rejoins them. Individual chunks are capped at ten seconds (320,000 bytes); normal G2 frames are much smaller.

```typescript
import { createSpeechModule } from './speech/index.js';
import { speechOptionsFromEnv } from './speech/config.js';

const sessionStartedAt = Date.now();
const speech = createSpeechModule({
  ...speechOptionsFromEnv(),
  onUtterance: utterance => logFinalUtterance(utterance),
  onWearerQuestion: question => {
    void matchAndDeliver(question).catch(handleSessionError);
  },
  onPair: pair => {
    // C owns persistence, daily expiry, and the store's shared record shape.
    void savePair({
      id: pair.answer.id,
      question: pair.question.text,
      answer: pair.answer.text,
      askedAt: new Date(sessionStartedAt + pair.question.endMs).toISOString(),
      answeredAt: new Date(sessionStartedAt + pair.answer.endMs).toISOString(),
      answeredBy: pair.answer.name,
      source: 'spoken',
      standing: false,
    }).catch(handleSessionError);
  },
  onError: handleSessionError,
  onLatency: measurement => logLatency(measurement),
});

// A's binary frame: speech.pushAudio(pcm)
// A's controls:     speech.pause(); speech.resume()
// Socket teardown: await speech.close()
```

The host functions in this example are C's integration points, not functions supplied by B. Callbacks are synchronous notifications; C handles asynchronous matcher/store errors. Pause cancels pending Q&A and in-flight transcripts; resume starts a new connection. Transport failure is reported once and stops processing until `resume()` or session replacement; C can implement its reconnect policy around that signal. Closing is idempotent and releases timers/sockets. An idle ElevenLabs connection closes proactively and reopens on the next speech frame; its new provider timestamps are mapped back into the original session.

## Classification and capture rules

- ElevenLabs uses RMS from the exact source-audio sentence range. It has no live speaker labels or names, so `speaker` and `name` are null; A uses the plan's time-only display wording.
- Timestamped multi-sentence ElevenLabs commits are split using the original transcript text and aligned word timestamps. Unsafe alignment is rejected before emitting any sentence. Answers are never generated, paraphrased, or semantically completed.
- A wearer question ends with `?` or starts with a question word/auxiliary. The newest wearer question replaces an earlier pending question. Only the next identifiable other-speaker statement can answer it; an unknown speaker or clarification question cancels capture. Wearer statements cannot be saved as answers.
- The answer must start after the question, within 30 seconds of original audio time, and arrive within 30 seconds of the final-question callback. Silence removed before transcription still counts toward the window. Overlap, duplicates, stale callbacks, and unavailable audio ranges do not create pairs.
- RMS is a heuristic, not diarization. Two people inside one sentence, overlapping speech, changing gain, or similar voice levels can defeat it. The real three-person test determines whether ElevenLabs is suitable; use the fallback if that test fails.

## Deepgram fallback and speaker setup

Set `SPEECH_PROVIDER=deepgram` and `DEEPGRAM_API_KEY` in `.env`. Run setup while each person speaks alone:

```typescript
speech.calibrateNextSpeaker({ isWearer: true });
// Wearer speaks one sentence and waits until it finalizes.
speech.calibrateNextSpeaker({ isWearer: false, name: 'Sarah' });
// Sarah speaks one sentence and waits until it finalizes.
```

Setup utterances are consumed without entering Q&A capture. The identified wearer label takes precedence over loudness; a calibrated threshold can classify unlabeled turns. `wearerSpeaker` and `speakerNames` options support a preconfigured initial connection, but labels are connection-local: pause/resume or recovery invalidates them, and setup must run again. Never assume label `0` belongs to the wearer. Only one setup request should be active at a time.

## Timing and real-room acceptance

`onLatency` first reports `transcriptMs` for each final wearer question. C can call `speech.markDisplayed(question.id, serverTimestamp)` only after A confirms the actual display to obtain `totalMs` and `withinTarget`. Sending a WebSocket answer is not proof of display. This hook does not change the agreed v1 phone protocol; A/C must arrange test instrumentation if they want an acknowledgement. Audio-clock timing assumes capture begins with module creation and uninterrupted real-time frames; account for transport/clock offsets when measuring the hardware.

Before declaring Role B's live acceptance complete:

1. Calibrate with real G2 recordings and verify the chosen threshold in quiet and venue noise.
2. Run a real two-commit ElevenLabs replay and a pause of more than 15 seconds; confirm timestamps, idle reconnection, and pairs are correct.
3. With three people, test wearer question → family answer → repeat, bystander question → wearer answer, overlapping speech, unrelated questions, and an answer more than 30 seconds later. Inspect every stored pair.
4. Repeat pause/resume and disconnect/recovery; ensure no pre-pause pair leaks across the boundary.
5. Have A and C measure actual question end → display over several repeats. Target B finalization ≤1 second and total ≤2 seconds; report measurements, not the synthetic demo's runtime.

Automated tests cover framing/RMS, silence/timestamps, calibration/WAV rejection, both provider protocols and bounded queues, a real local WebSocket, sentence-level ElevenLabs Q&A, speaker setup, timeouts, overlap, duplicate suppression, pause/resume, recovery, fake playback, and idle connection rotation. External provider accuracy, network latency, and physical glasses behavior are not simulated acceptance evidence.

Provider protocol sources are linked in `src/speech/elevenlabs.ts` and `src/speech/deepgram.ts`. The implementation uses server-side `ws` with the documented wire protocols, avoiding a browser SDK or exposed provider keys.
