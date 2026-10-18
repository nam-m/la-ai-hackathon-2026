import { randomUUID } from 'node:crypto';
import { AudioPipeline } from './audio.js';
import { createDeepgramProvider } from './deepgram.js';
import { createElevenLabsProvider } from './elevenlabs.js';
import { readFakeScript, type FakeLine } from './fake.js';
import { isQuestion } from './questions.js';
import { SpeechLatencyTracker, type LatencyMeasurement } from './latency.js';
import type { ProviderFactory, ProviderUtterance, QAPair, SpeechModule, SpeechProvider, Utterance } from './types.js';

export type { Utterance, QAPair, SpeechModule } from './types.js';
export { isQuestion } from './questions.js';
export { SpeechLatencyTracker } from './latency.js';

export type SpeechOptions = {
  provider: 'elevenlabs' | 'deepgram' | 'fake';
  apiKey: string;
  onUtterance(u: Utterance): void;
  onWearerQuestion(q: Utterance): void;
  onPair(p: QAPair): void;
  onError(e: Error): void;
  wearerThresholdDb?: number;
  /** Labels belong to the initial Deepgram connection only. Recalibrate after resume. */
  wearerSpeaker?: string;
  speakerNames?: Record<string, string>;
  silenceThresholdDb?: number;
  hangoverMs?: number;
  fakeScriptPath?: string;
  fakeScript?: FakeLine[];
  onLatency?(measurement: LatencyMeasurement): void;
  /** Injectable transport and clock for deterministic integration tests. */
  providerFactory?: ProviderFactory;
  now?: () => number;
};

export interface ConfigurableSpeechModule extends SpeechModule {
  /** The next finalized, single-speaker Deepgram turn is setup, never a Q&A. */
  calibrateNextSpeaker(person: { isWearer: boolean; name?: string }): void;
  /** Optional hook for C when A confirms the answer was actually displayed. */
  markDisplayed(questionId: string, displayedAt?: number): LatencyMeasurement | null;
}

export function createSpeechModule(opts: SpeechOptions): ConfigurableSpeechModule {
  if (!['elevenlabs', 'deepgram', 'fake'].includes(opts.provider)) throw new Error('Unknown speech provider');
  if (opts.provider !== 'fake' && !opts.apiKey.trim()) throw new Error('A server-side speech API key is required');
  if (opts.wearerThresholdDb !== undefined && (!Number.isFinite(opts.wearerThresholdDb) || opts.wearerThresholdDb < -120 || opts.wearerThresholdDb > 0)) {
    throw new Error('wearerThresholdDb must be a finite dBFS value between -120 and 0');
  }
  const now = opts.now ?? Date.now;
  const sessionStart = now();
  const idPrefix = randomUUID();
  const latency = new SpeechLatencyTracker();
  let sequence = 0;
  let generation = 0;
  let paused = false;
  let closed = false;
  let failed = false;
  let provider: SpeechProvider | undefined;
  let audio: AudioPipeline | undefined;
  let forwardedMs = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: { question: Utterance; receivedAt: number } | undefined;
  let wearerSpeaker = opts.wearerSpeaker;
  let names = new Map(Object.entries(opts.speakerNames ?? {}));
  let setup: { isWearer: boolean; name?: string } | undefined;
  let fakeTimer: ReturnType<typeof setTimeout> | undefined;
  let fakeIndex = 0;
  let fakeElapsed = 0;
  let fakeResumedAt = now();
  const fakeLines = opts.provider === 'fake' ? (opts.fakeScript ?? readFakeScript(opts.fakeScriptPath)) : [];
  let closePromise: Promise<void> | undefined;
  const closing = new Set<Promise<void>>();
  const seen = new Set<string>();

  function report(error: Error): void { opts.onError(error); }
  function stopProvider(): void {
    clearTimeout(idleTimer);
    const old = provider;
    provider = undefined;
    if (old) {
      const result = old.close().catch(() => undefined);
      closing.add(result);
      void result.finally(() => closing.delete(result));
    }
  }
  function fail(error: Error): void {
    if (closed || failed) return;
    failed = true;
    generation++;
    pending = undefined;
    setup = undefined;
    latency.clear();
    stopProvider();
    report(error);
  }
  function emit(u: Utterance, identityKnown: boolean): void {
    if (closed || paused || failed) return;
    const current = generation;
    opts.onUtterance(u);
    if (closed || paused || failed || current !== generation) return;
    if (u.isWearer && isQuestion(u.text)) {
      pending = { question: u, receivedAt: now() };
      const measurement = latency.markFinal(u.id, sessionStart + u.endMs, now());
      opts.onWearerQuestion(u);
      if (!closed && !paused && !failed && current === generation) opts.onLatency?.(measurement);
    } else if (pending && !u.isWearer) {
      const previous = pending;
      // An unidentifiable turn or another question must not become an answer.
      pending = undefined;
      const gap = u.startMs - previous.question.endMs;
      if (identityKnown && !isQuestion(u.text) && gap >= 0 && gap <= 30_000 && now() - previous.receivedAt <= 30_000) {
        opts.onPair({ question: previous.question, answer: u });
      }
    }
  }
  function receive(raw: ProviderUtterance): void {
    if (!raw.text.trim() || !Number.isFinite(raw.startMs) || !Number.isFinite(raw.endMs) || raw.startMs < 0 || raw.endMs <= raw.startMs) return;
    const fingerprint = `${raw.startMs}:${raw.endMs}:${raw.speaker}:${raw.text}`;
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    if (seen.size > 1000) seen.delete(seen.values().next().value!);
    const range = audio?.mapRange(raw.startMs, raw.endMs);
    if (!range) return;
    let identityKnown = false;
    let isWearer = false;
    if (opts.provider === 'deepgram' && raw.speaker !== null && wearerSpeaker !== undefined) {
      identityKnown = true;
      isWearer = raw.speaker === wearerSpeaker;
    } else if (opts.wearerThresholdDb !== undefined) {
      identityKnown = true;
      isWearer = range.rmsDb >= opts.wearerThresholdDb;
    }
    const u: Utterance = { ...range, id: `${idPrefix}:${++sequence}`, text: raw.text, speaker: raw.speaker,
      name: raw.speaker === null ? null : (names.get(raw.speaker) ?? null), isWearer };
    if (setup && opts.provider === 'deepgram') {
      pending = undefined;
      if (raw.speaker === null) return;
      if (setup.isWearer) wearerSpeaker = raw.speaker;
      else if (wearerSpeaker === raw.speaker) { report(new Error('Setup speaker matches the wearer; retry in a quiet room')); return; }
      if (setup.name) names.set(raw.speaker, setup.name);
      setup = undefined;
      return;
    }
    emit(u, identityKnown);
  }
  function connectProvider(): void {
    const current = ++generation;
    const offset = forwardedMs;
    const factory = opts.providerFactory ?? (opts.provider === 'deepgram' ? createDeepgramProvider : createElevenLabsProvider);
    try {
      provider = factory({ apiKey: opts.apiKey,
        onUtterance(u) { if (current === generation && !closed && !paused && !failed) receive({ ...u, startMs: u.startMs + offset, endMs: u.endMs + offset }); },
        onError(e) { if (current === generation) fail(e); } });
      if (failed || closed || paused) stopProvider();
    } catch (error) { fail(error instanceof Error ? error : new Error('Could not start speech provider')); }
  }
  function startLive(): void {
    forwardedMs = 0;
    audio = new AudioPipeline({ startMs: Math.max(0, now() - sessionStart), silenceThresholdDb: opts.silenceThresholdDb,
      hangoverMs: opts.hangoverMs, onFrame(frame) {
        if (closed || paused || failed) return;
        if (!provider) connectProvider();
        if (closed || paused || failed || !provider) return;
        provider.sendAudio(frame);
        forwardedMs += frame.byteLength / 32;
        if (opts.provider === 'elevenlabs' && !failed) {
          clearTimeout(idleTimer);
          // ElevenLabs has no documented client keepalive without audio. Close
          // before its 15-second idle limit and reopen when speech resumes.
          idleTimer = setTimeout(() => { generation++; stopProvider(); }, 8000);
          idleTimer.unref();
        }
      } });
    if (opts.provider === 'deepgram') connectProvider();
  }
  function scheduleFake(): void {
    const next = fakeLines[fakeIndex];
    if (!next || closed || paused) return;
    const elapsed = fakeElapsed + now() - fakeResumedAt;
    fakeTimer = setTimeout(() => {
      if (closed || paused) return;
      fakeIndex++;
      const endMs = Math.max(0, now() - sessionStart);
      emit({ ...next, id: `${idPrefix}:${++sequence}`, startMs: Math.max(0, endMs - (next.endMs - next.startMs)), endMs,
        rmsDb: next.isWearer ? -18 : -36, speaker: next.isWearer ? 'wearer' : 'other' }, true);
      scheduleFake();
    }, Math.max(0, next.endMs - elapsed));
  }
  if (opts.provider === 'fake') scheduleFake(); else startLive();
  return {
    pushAudio(pcm) {
      if (closed || paused || failed || opts.provider === 'fake') return;
      if (!(pcm instanceof Uint8Array)) { fail(new Error('Audio must be raw PCM bytes in a Uint8Array')); return; }
      // Limit an individual frame to avoid unbounded allocations from a broken client.
      if (pcm.byteLength > 320_000) { fail(new Error('Audio frame exceeds 10 seconds; send smaller PCM chunks')); return; }
      audio?.push(pcm);
    },
    pause() {
      if (closed || paused) return;
      paused = true;
      generation++;
      pending = undefined;
      setup = undefined;
      seen.clear();
      latency.clear();
      clearTimeout(fakeTimer);
      fakeElapsed += now() - fakeResumedAt;
      stopProvider();
    },
    resume() {
      if (closed || (!paused && !failed)) return;
      paused = false;
      failed = false;
      // Provider diarization labels are connection-local. Never reuse old labels.
      wearerSpeaker = undefined;
      names = new Map();
      seen.clear();
      fakeResumedAt = now();
      if (opts.provider === 'fake') scheduleFake(); else startLive();
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      generation++;
      pending = undefined;
      latency.clear();
      clearTimeout(fakeTimer);
      stopProvider();
      closePromise = Promise.all([...closing]).then(() => undefined);
      return closePromise;
    },
    calibrateNextSpeaker(person) {
      if (closed || paused || failed) throw new Error('Resume speech before speaker setup');
      if (opts.provider !== 'deepgram') throw new Error('Speaker-label setup is available with Deepgram only; use loudness calibration for ElevenLabs');
      pending = undefined;
      setup = person;
    },
    markDisplayed(questionId, displayedAt = now()) {
      const measurement = latency.markDisplayed(questionId, displayedAt);
      if (measurement) opts.onLatency?.(measurement);
      return measurement;
    },
  };
}
