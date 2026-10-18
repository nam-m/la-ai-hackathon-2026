# Role B: speech (spec v4.2)

The implementation lives in `server/src/speech/`, as specified in the root folder plan. C imports `createSpeechModule` and its types from `./speech/index.js`. Test and recording tools live in `server/scripts/`; automated tests live in `server/test/`.

## Run and verify

Use Node 22.9 or newer. From `server/`:

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run speech:demo
```

The short speech demo uses synthetic transcripts and makes no API calls. `npm start` runs C's server; its default fake provider reads `scripts/fake-script.txt`. Run `npm run fake-phone` in another terminal to exercise the phone socket. The fake script supports the server's `delaySeconds | wearer/Name/unknown | text` format and the original tab-separated `endMs, wearer/other/unknown, name-or-dash, text` format. Fake timings are simulated audio time, not evidence of provider accuracy or device latency.

## ElevenLabs setup

Copy `server/.env.example` to `server/.env` only if you do not already have a local file. Keep existing keys local. For live transcription set:

```dotenv
SPEECH_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=your-local-key
SPEECH_WEARER_THRESHOLD_DB=
SPEECH_WEARER_MARGIN_DB=3
```

C's existing `SPEECH_API_KEY` setting is also supported and takes precedence when nonempty. Each developer can supply their own authorized key, or the team can configure a shared backend's server environment; keys never belong in the phone application. Do not send `.env` with a code handoff.

A blank wearer threshold permits transcripts but makes unlabeled speech `unknown`. To capture questions and replies on ElevenLabs, fill it from **real G2 microphone calibration**, using the same gain and wearing position as the demo. Do not copy a synthetic test threshold.

1. Capture at least five separate wearer sentences and five companion sentences through A's glasses audio path, including quiet and louder speech. Use 16 kHz mono signed 16-bit little-endian PCM or PCM WAV.
2. Put the recordings in `server/data/` and create a manifest using `server/examples/calibration-manifest.json`. Trim leading and trailing silence while preserving the recorded amplitudes. Paths in the manifest are relative to that file.
3. Run `npm run speech:calibrate -- --manifest data/recordings.json --output data/calibration.json`.
4. When the report has a clear gap, set its `thresholdDb` as `SPEECH_WEARER_THRESHOLD_DB`. The default confidence margin is 3 dB on either side; near-threshold speech stays unknown. If the recordings cannot be separated, collect better calibration or explicitly switch to Deepgram. There is no automatic provider switch.
5. Restart the server and run `npm run speech:replay -- data/conversation.wav` to inspect final transcripts, roles and candidate pairs.

The new v4.2 spec restores calibrated loudness attribution. ElevenLabs provides no live speaker names, and G2 PCM does not supply a guaranteed wearer-role field. Loudness remains a heuristic: it cannot reliably detect simultaneous voices or people moving nearer the microphone. Detected overlap and ambiguous attribution produce `unknown` and do not enter matching or answer capture.

## Laptop recorder

For a simple **transcription-only** test, set `ELEVENLABS_API_KEY` and run `npm run speech:record`, then open `http://127.0.0.1:8787` in Chrome or Edge. Start the microphone, speak, then choose **Stop & test with ElevenLabs**. This harness deliberately does not use the server's glasses calibration; every real transcript remains unassigned. No near/far calibration step is required on this page.

Audio is sent to ElevenLabs when testing starts. The harness saves the recording and results under ignored `server/data/device-tests/`. Cancel stops capture or replay but does not delete existing saved files. It does not test the glasses display, real speaker attribution, repeat matcher or tone model.

## Contract and behavior

- Questions: a trailing `?` is a question and a trailing `.` or `!` is not; question starter words decide only unpunctuated text or text ending in `...`/`…` (`can't` doesn't count as `can`). Trade-off: a question the provider wrongly ends with `.` is not treated as one.
- Only final provider transcripts are emitted. Each utterance includes `role: wearer | other | unknown`, and `isWearer` always equals `role === 'wearer'`. Provider labels are never guessed to mean wearer.
- Audio is signed 16-bit little-endian, 16 kHz mono. Pass raw PCM to `pushAudio`, not WAV headers. Normal messages should be small frames; each call is limited to ten seconds. The module joins split samples. C's phone socket requires sample-aligned frames.
- `startMs` and `endMs` use the source PCM byte clock from the first received audio, including silence removed before transcription. Startup delays and time spent paused do not shift the timeline. C cuts the question's exact audio from its own 60-second ring for tone analysis. B uses bounded transient audio for RMS/timestamp mapping and does not persist live audio.
- Wearer questions fire immediately through `onWearerQuestion`. Every subsequent `other` utterance that starts within 30 seconds after that question ends is an `onPair` **candidate**, including clarification questions. Unknown speech and wearer statements do not answer or close the window. A new wearer question replaces it. Duplicates, out-of-order or overlapping turns do not produce eligible pairs.
- C checks candidates serially in spoken order, skips unrelated remarks, saves the earliest valid reply once, and rejects pending work after a newer question, pause, failure or close. B never verifies semantics or writes an answer. The source transcript remains verbatim.
- Pause invalidates pending callbacks and closes the transcription connection. Resume starts a fresh connection. A failed or dropped provider connection is reopened on the next audio frame, up to 3 times per minute, on the same source clock (audio already sent to the dropped connection is not transcribed, and Deepgram speaker labels start fresh); after that, the error is reported and transcription stops until resume or session replacement. Auth, quota and missing-key errors are reported at once, since reconnecting can't fix them. There is no hidden switch to another provider. A single final with malformed or out-of-range timestamps (beyond 20 ms of rounding) is dropped and logged without its text, instead of ending the connection. ElevenLabs connections retire during idle silence and reopen when speech returns.
- Deepgram labels are connection-local. Set `SPEECH_PROVIDER=deepgram` with `DEEPGRAM_API_KEY` or `SPEECH_API_KEY`. A host can call `calibrateNextSpeaker({isWearer: true})`, then the wearer speaks alone; repeat with `{isWearer:false, name:'Sarah'}` for a companion. Initial `SPEECH_WEARER_SPEAKER` and JSON `SPEECH_SPEAKER_NAMES` settings are supported, but must not be assumed valid after reconnection. Loudness calibration can also be used with this fallback.
- `onLatency` estimates final-transcript timing from server PCM arrival; it does not measure the phone/network capture-to-arrival delay. `markDisplayed` requires an actual display acknowledgement from A. Synthetic timers and a WebSocket send do not prove display latency.

Tone analysis belongs to C's `server/src/emotion/` and `tone-service/` in v4.2. B supplies correctly attributed questions and source audio timestamps. Tone runs alongside matching and never changes the answer. No Hume integration is required.

## Acceptance still requiring real hardware

Automated tests check provider messages, role abstention, candidate windows, silence mapping, lifecycle behavior, C integration and recording tools. Before marking the live demo accepted:

- Calibrate on the G2 and confirm companion speech is `other`, with uncertain speech `unknown`.
- Replay multiple committed sentences in one ElevenLabs connection; confirm their timestamps against the original audio, then repeat after an idle pause and pause/resume.
- Test wearer question, unrelated companion remark, real reply, repeat; verify only the real reply is saved and displayed. Test bystanders, overlapping voices and replies outside 30 seconds.
- Measure actual transcript and display latency on the venue network, including reconnect and phone lock. The v4.2 target is about two seconds typical and about three maximum, with C's matcher deadline enforced separately.
- With C/D, verify tone uses the correct question clip, remains off when disabled, and never blocks an answer if its service is unavailable.

These checks require consented recordings, configured external services and the device. Passing local tests does not establish those outcomes.
