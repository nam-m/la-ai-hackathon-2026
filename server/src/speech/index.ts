import { randomUUID } from 'node:crypto';
import { AudioPipeline } from './audio.js';
import { createDeepgramProvider } from './deepgram.js';
import { createElevenLabsProvider } from './elevenlabs.js';
import { readFakeScript, type FakeLine } from './fake.js';
import { isQuestion } from './questions.js';
import { SpeechLatencyTracker, type LatencyMeasurement } from './latency.js';
import type { ProviderFactory, ProviderUtterance, QAPair, SpeakerRole, SpeechModule, SpeechProvider, Utterance } from './types.js';

export type { Utterance, QAPair, SpeakerRole, SpeechModule } from './types.js';
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
  /** Abstain within this many dB on either side of the calibrated threshold. */
  wearerMarginDb?: number;
  /** Labels belong to the initial Deepgram connection only. Recalibrate after resume. */
  wearerSpeaker?: string;
  speakerNames?: Record<string, string>;
  silenceThresholdDb?: number;
  /**
   * Role for an utterance from another source on the same audio clock (the glasses' own speakerRole
   * tags, sent by the phone). It decides before Deepgram labels and loudness; undefined defers to them.
   */
  roleAt?(startMs: number, endMs: number): SpeakerRole | undefined;
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
  const wearerMarginDb = opts.wearerMarginDb ?? 3;
  if (!Number.isFinite(wearerMarginDb) || wearerMarginDb < 0) throw new Error('wearerMarginDb must be a finite nonnegative number');
  const now = opts.now ?? Date.now;
  const idPrefix = randomUUID();
  const latency = new SpeechLatencyTracker();
  let sequence = 0;
  let generation = 0;
  let paused = false;
  let closed = false;
  let failed = false;
  let provider: SpeechProvider | undefined;
  let audio: AudioPipeline | undefined;
  // Same source clock as C's PCM ring. Time advances only on accepted bytes,
  // including skipped silence and bytes received while a provider has failed.
  let sourceBytes = 0;
  const arrivals: { startMs: number; endMs: number; wallEnd: number }[] = [];
  let latestFinalEndMs = 0;
  let forwardedMs = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: Utterance | undefined;
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
  // A dropped or failing provider connection is retried before transcription is reported as down:
  // the dead connection is closed and the next audio frame reconnects (the same path as an idle
  // ElevenLabs close), so the source clock mapping is unchanged. Audio already sent to the dead
  // connection is not transcribed. Errors a reconnect can't fix (auth, quota, missing key) fail at once.
  const RETRY_LIMIT = 3;
  const RETRY_WINDOW_MS = 60_000;
  const PERMANENT = /auth_error|quota_exceeded|unaccepted_terms|API key is required|requires an API key|handshake was rejected/;
  let retries: number[] = [];
  function retryOrFail(error: Error): void {
    if (closed || failed || paused) return;
    if (PERMANENT.test(error.message)) { fail(error); return; }
    const t = now();
    retries = retries.filter(at => t - at < RETRY_WINDOW_MS);
    if (retries.length >= RETRY_LIMIT) { fail(error); return; }
    retries.push(t);
    generation++;
    stopProvider();
    // The open answer window survives (the question was attributed on the old connection).
    // Provider labels are connection-local (as on resume): never carry them into the new connection.
    wearerSpeaker = undefined;
    names = new Map();
    setup = undefined;
    seen.clear();
    console.warn(`[speech] provider connection failed; reconnecting on next audio (${retries.length}/${RETRY_LIMIT})`);
  }
  function emit(u: Utterance): void {
    if (closed || paused || failed) return;
    const current = generation;
    opts.onUtterance(u);
    if (closed || paused || failed || current !== generation) return;
    if (u.role === 'wearer' && isQuestion(u.text)) {
      pending = u;
      // Source PCM time excludes wall-time pauses. Locate the original input
      // chunk instead of treating the PCM offset as elapsed time since startup.
      let arrival: typeof arrivals[number] | undefined;
      for (let i = arrivals.length - 1; i >= 0; i--) {
        const frame = arrivals[i]!;
        if (u.endMs > frame.startMs && u.endMs <= frame.endMs + 1e-6) { arrival = frame; break; }
      }
      const speechEndAt = opts.provider === 'fake' ? now() : arrival ? arrival.wallEnd - (arrival.endMs - u.endMs) : undefined;
      const measurement = speechEndAt === undefined ? undefined : latency.markFinal(u.id, speechEndAt, now());
      opts.onWearerQuestion(u);
      if (measurement && !closed && !paused && !failed && current === generation) opts.onLatency?.(measurement);
    } else if (pending && u.role === 'other') {
      const gap = u.startMs - pending.endMs;
      // Every other-person line, including a clarification question, is a
      // candidate. C verifies actual replies; rejection keeps this window open.
      if (gap >= 0 && gap <= 30_000) opts.onPair({ question: pending, answer: u });
      else if (gap > 30_000) pending = undefined;
    }
  }
  function receive(raw: ProviderUtterance): void {
    if (!raw.text.trim() || !Number.isFinite(raw.startMs) || !Number.isFinite(raw.endMs) || raw.startMs < 0 || raw.endMs <= raw.startMs) return;
    const fingerprint = `${raw.startMs}:${raw.endMs}:${raw.speaker}:${raw.text}`;
    if (seen.has(fingerprint)) return;
    const range = audio?.mapRange(raw.startMs, raw.endMs);
    if (!range) return;
    seen.add(fingerprint);
    if (seen.size > 1000) seen.delete(seen.values().next().value!);
    // Providers normally emit in spoken order. An overlapping or stale final
    // remains visible, but must not replace the latest question or reorder
    // answer candidates that C has already begun checking.
    const outOfOrder = range.startMs < latestFinalEndMs;
    latestFinalEndMs = Math.max(latestFinalEndMs, range.endMs);
    let role: SpeakerRole = 'unknown';
    if (!raw.uncertain && !outOfOrder && range.rmsDb > (opts.silenceThresholdDb ?? -50)) {
      const tagged = opts.roleAt?.(range.startMs, range.endMs);
      if (tagged !== undefined) {
        role = tagged;
      } else if (opts.provider === 'deepgram' && raw.speaker !== null && wearerSpeaker !== undefined) {
        role = raw.speaker === wearerSpeaker ? 'wearer' : 'other';
      } else if (opts.wearerThresholdDb !== undefined) {
        if (range.rmsDb >= opts.wearerThresholdDb + wearerMarginDb) role = 'wearer';
        else if (range.rmsDb <= opts.wearerThresholdDb - wearerMarginDb) role = 'other';
      }
    }
    const u: Utterance = { ...range, id: `${idPrefix}:${++sequence}`, text: raw.text, speaker: raw.speaker,
      name: role === 'unknown' || raw.speaker === null ? null : (names.get(raw.speaker) ?? null), role, isWearer: role === 'wearer' };
    if (setup && opts.provider === 'deepgram') {
      pending = undefined;
      if (raw.speaker === null || raw.uncertain || outOfOrder || range.rmsDb <= (opts.silenceThresholdDb ?? -50)) return;
      if (setup.isWearer) wearerSpeaker = raw.speaker;
      else if (wearerSpeaker === raw.speaker) { report(new Error('Setup speaker matches the wearer; retry in a quiet room')); return; }
      if (setup.name) names.set(raw.speaker, setup.name);
      setup = undefined;
      return;
    }
    emit(u);
  }
  function connectProvider(): void {
    const current = ++generation;
    const offset = forwardedMs;
    const factory = opts.providerFactory ?? (opts.provider === 'deepgram' ? createDeepgramProvider : createElevenLabsProvider);
    try {
      provider = factory({ apiKey: opts.apiKey,
        onUtterance(u) { if (current === generation && !closed && !paused && !failed) receive({ ...u, startMs: u.startMs + offset, endMs: u.endMs + offset }); },
        onError(e) { if (current === generation) retryOrFail(e); } });
      if (failed || closed || paused) stopProvider();
    } catch (error) { fail(error instanceof Error ? error : new Error('Could not start speech provider')); }
  }
  function startLive(): void {
    forwardedMs = 0;
    const pipeline = new AudioPipeline({ startMs: sourceBytes / 32, silenceThresholdDb: opts.silenceThresholdDb,
      hangoverMs: opts.hangoverMs, onFrame(frame) {
        if (audio !== pipeline || closed || paused || failed) return;
        if (!provider) connectProvider();
        if (closed || paused || failed || !provider) return;
        const connection = generation;
        provider.sendAudio(frame);
        if (audio !== pipeline || generation !== connection || closed || paused || failed) return;
        forwardedMs += frame.byteLength / 32;
        if (opts.provider === 'elevenlabs' && !failed) {
          clearTimeout(idleTimer);
          // ElevenLabs has no documented client keepalive without audio. Close
          // before its 15-second idle limit and reopen when speech resumes.
          idleTimer = setTimeout(() => { generation++; stopProvider(); }, 8000);
          idleTimer.unref();
        }
      } });
    audio = pipeline;
    if (opts.provider === 'deepgram') connectProvider();
  }
  function scheduleFake(): void {
    const next = fakeLines[fakeIndex];
    if (!next || closed || paused) return;
    const elapsed = fakeElapsed + now() - fakeResumedAt;
    fakeTimer = setTimeout(() => {
      if (closed || paused) return;
      fakeIndex++;
      const role = next.role ?? (next.isWearer ? 'wearer' : 'other');
      emit({ ...next, id: `${idPrefix}:${++sequence}`, role, isWearer: role === 'wearer',
        rmsDb: role === 'wearer' ? -18 : role === 'other' ? -36 : -120,
        speaker: role === 'unknown' ? null : role, name: role === 'unknown' ? null : next.name });
      scheduleFake();
    }, Math.max(0, next.endMs - elapsed));
  }
  if (opts.provider === 'fake') scheduleFake(); else startLive();
  return {
    pushAudio(pcm) {
      if (closed || opts.provider === 'fake') return;
      if (!(pcm instanceof Uint8Array)) { fail(new Error('Audio must be raw PCM bytes in a Uint8Array')); return; }
      const startMs = sourceBytes / 32;
      sourceBytes += pcm.byteLength;
      if (pcm.byteLength) {
        arrivals.push({ startMs, endMs: sourceBytes / 32, wallEnd: now() });
        const cutoff = sourceBytes / 32 - 120_000;
        while (arrivals.length && (arrivals[0]!.endMs <= cutoff || arrivals.length > 4096)) arrivals.shift();
      }
      // Limit an individual frame to avoid unbounded allocations from a broken client.
      if (pcm.byteLength > 320_000) { fail(new Error('Audio frame exceeds 10 seconds; send smaller PCM chunks')); return; }
      if (paused || failed) return;
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
      retries = [];
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
