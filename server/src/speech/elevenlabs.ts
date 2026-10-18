import WebSocket, { type ClientOptions, type RawData } from 'ws';
import type { ProviderOptions, ProviderUtterance, SpeechProvider } from './types.js';

const BYTES_PER_MS = 32; // Signed 16-bit little-endian, 16 kHz, mono.
const CHUNK_BYTES = 3_200; // 100 ms: the documented lower end of 0.1–1 s.
const MAX_PENDING_BYTES = 160_000; // Five seconds, never silently drop audio.
const MAX_SOCKET_BUFFER_BYTES = 256_000;
const ERROR_TYPES = new Set([
  'error', 'auth_error', 'quota_exceeded', 'transcriber_error', 'input_error',
  'invalid_request', 'commit_throttled', 'unaccepted_terms', 'rate_limited',
  'queue_overflow', 'resource_exhausted', 'session_time_limit_exceeded',
  'chunk_size_exceeded', 'insufficient_audio_activity', 'throttled',
]);

type TimedWord = { text: unknown; startMs: number; endMs: number; uncertain?: boolean };
const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const NON_TERMINAL_ABBREVIATION = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|vs|e\.g|i\.e)\.|^(?:[A-Z]\.)+)$/iu;
// Punctuation may exist only in the full transcript, rather than word tokens.
// Every other visible character must be covered by an aligned token.
const ONLY_UNTIMED_SEPARATORS = /^[\p{P}\p{Z}\s]*$/u;

function splitSentences(text: string, words: TimedWord[], sentMs: number): ProviderUtterance[] | null {
  const candidates = Array.from(sentenceSegmenter.segment(text), ({ segment, index }) => {
    const leading = segment.length - segment.trimStart().length;
    return { start: index + leading, end: index + segment.trimEnd().length };
  }).filter((range) => range.end > range.start);
  const ranges: { start: number; end: number }[] = [];
  for (const range of candidates) {
    const previous = ranges[ranges.length - 1];
    // ICU may split honorifics such as "Dr. Smith" into two sentences.
    if (previous && NON_TERMINAL_ABBREVIATION.test(text.slice(previous.start, previous.end))) previous.end = range.end;
    else ranges.push(range);
  }
  // A single sentence can use the whole validated range even when the API's
  // optional word text is absent. Splitting requires complete text alignment.
  if (ranges.length === 1) return [{ text: text.trim(),
    startMs: Math.min(...words.map((word) => word.startMs)),
    endMs: Math.min(sentMs, Math.max(...words.map((word) => word.endMs))), speaker: null,
    ...(words.some(word => word.uncertain) ? { uncertain: true } : {}) }];
  if (!ranges.length) return null;
  const groups: TimedWord[][] = ranges.map(() => []);
  let cursor = 0;
  let sentence = 0;
  for (const word of words) {
    if (typeof word.text !== 'string' || !word.text.trim()) return null;
    const token = word.text.trim();
    const start = text.indexOf(token, cursor);
    if (start < 0 || !ONLY_UNTIMED_SEPARATORS.test(text.slice(cursor, start))) return null;
    const end = start + token.length;
    while (sentence < ranges.length && start >= ranges[sentence]!.end) sentence++;
    const range = ranges[sentence];
    // A word spanning a sentence boundary cannot supply separate audio ranges.
    if (!range || start < range.start || end > range.end) return null;
    groups[sentence]!.push(word);
    cursor = end;
  }
  if (!ONLY_UNTIMED_SEPARATORS.test(text.slice(cursor))) return null;
  const result: ProviderUtterance[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const group = groups[i]!;
    if (!group.length) return null;
    const startMs = Math.min(...group.map((word) => word.startMs));
    const endMs = Math.min(sentMs, Math.max(...group.map((word) => word.endMs)));
    if (endMs <= startMs) return null;
    const range = ranges[i]!;
    result.push({ text: text.slice(range.start, range.end), startMs, endMs, speaker: null,
      ...(group.some(word => word.uncertain) ? { uncertain: true } : {}) });
  }
  return result;
}

/** Optional transport injection keeps tests local, without API keys or network access. */
export type ElevenLabsTransport = {
  createWebSocket?: (url: string, options: ClientOptions) => WebSocket;
  connectTimeoutMs?: number;
  closeTimeoutMs?: number;
};

/**
 * Protocol checked against the official docs on 2026-10-17:
 * https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
 * https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/transcripts-and-commit-strategies
 * https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/event-reference
 *
 * Input must include trailing silence: VAD cannot commit when quiet audio is
 * removed. The service closes after 15 s without client messages, and its
 * keepalive_interval_ms only creates server messages while processing PCM.
 * There is no documented client keepalive that safely replaces silent PCM.
 * The core therefore opens this adapter lazily, retires idle connections before
 * that limit, and translates new connection timestamps into its cumulative PCM
 * clock. No fabricated silence, speculative ping, or reconnect is added here.
 * Word timestamps are interpreted as seconds from this connection's audio
 * origin; SDK event handling forwards them without a per-commit adjustment.
 * The public docs do not explicitly state the cross-commit origin, so a live
 * multi-commit replay remains a required timing calibration check.
 * Multi-sentence commits are split using exact text/word alignment so each
 * sentence gets its own RMS range in the core. Timestamp output still cannot
 * separate multiple speakers inside one sentence. Overlapping word timestamps
 * flag an uncertain range, but overlap detection is not guaranteed. Unmarked
 * cases still require real-microphone calibration/diarization.
 * close() cancels this connection, including any uncommitted tail/results.
 */
export function createElevenLabsProvider(
  options: ProviderOptions,
  transport: ElevenLabsTransport = {},
): SpeechProvider {
  let socket: WebSocket | undefined;
  let stopped = false;
  let ready = false;
  let pending = Buffer.alloc(0);
  let sentBytes = 0;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let closePromise: Promise<void> | undefined;
  let resolveClose: (() => void) | undefined;
  const seen = new Set<string>();

  function clearPending(): void {
    pending = Buffer.alloc(0);
    if (connectTimer) clearTimeout(connectTimer);
    connectTimer = undefined;
    seen.clear();
  }

  function finishClose(): void {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = undefined;
    resolveClose?.();
    resolveClose = undefined;
  }

  function fail(message: string): void {
    if (stopped) return;
    stopped = true;
    clearPending();
    // Do not expose provider payloads, URLs, headers, or underlying errors.
    try { socket?.terminate(); } catch { /* already disconnected */ }
    finishClose();
    options.onError(new Error(`ElevenLabs transcription ${message}`));
  }

  function flush(): void {
    while (!stopped && ready && pending.length >= CHUNK_BYTES) {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        fail('connection is unavailable');
        return;
      }
      const chunk = pending.subarray(0, CHUNK_BYTES);
      const payload = JSON.stringify({
        message_type: 'input_audio_chunk', audio_base_64: chunk.toString('base64'),
        sample_rate: 16_000, commit: false,
      });
      if (socket.bufferedAmount + Buffer.byteLength(payload) > MAX_SOCKET_BUFFER_BYTES) {
        fail('connection is too slow');
        return;
      }
      pending = pending.subarray(CHUNK_BYTES);
      try {
        socket.send(payload, (error) => { if (error) fail('audio send failed'); });
        sentBytes += chunk.length;
      } catch {
        fail('audio send failed');
      }
    }
  }

  function onMessage(raw: RawData): void {
    if (stopped) return;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw.toString());
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      message = parsed as Record<string, unknown>;
    } catch {
      fail('received an invalid message');
      return;
    }
    const type = message.message_type;
    if (typeof type !== 'string') {
      fail('received an invalid message');
      return;
    }
    if (ERROR_TYPES.has(type)) {
      fail(`failed (${type})`);
      return;
    }
    if (type === 'session_started') {
      if (ready) return;
      ready = true;
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = undefined;
      flush();
      return;
    }
    // Plain commits are followed by a separate timestamped commit; only emit
    // the latter. Partial, edited, and other non-final messages are ignored.
    if (type !== 'committed_transcript_with_timestamps') return;
    if (typeof message.text !== 'string' || !message.text.trim()) return;
    if (!ready || !Array.isArray(message.words) || message.words.length === 0) {
      fail('received a transcript without valid timestamps');
      return;
    }
    let startMs = Infinity;
    let endMs = -Infinity;
    let previousStart = -Infinity;
    const words: TimedWord[] = [];
    for (const entry of message.words) {
      if (!entry || typeof entry !== 'object') {
        fail('received invalid word timestamps');
        return;
      }
      const word = entry as Record<string, unknown>;
      if (word.type === 'spacing') continue;
      if (typeof word.start !== 'number' || typeof word.end !== 'number'
        || !Number.isFinite(word.start) || !Number.isFinite(word.end)
        || word.start < 0 || word.end < word.start || word.start < previousStart) {
        fail('received invalid word timestamps');
        return;
      }
      previousStart = word.start;
      startMs = Math.min(startMs, word.start * 1_000);
      endMs = Math.max(endMs, word.end * 1_000);
      words.push({ text: word.text, startMs: word.start * 1_000, endMs: word.end * 1_000 });
    }
    // Word intervals that overlap cannot supply a clean single-voice RMS
    // range, even when punctuation combines them into one sentence. Retain
    // recognized words but force downstream attribution to abstain.
    let cluster: TimedWord[] = [];
    let priorEnd = -Infinity;
    const markCluster = () => {
      if (cluster.length > 1) for (const word of cluster) word.uncertain = true;
    };
    for (const word of words) {
      if (word.startMs >= priorEnd - 1 / 16) { markCluster(); cluster = []; }
      cluster.push(word);
      priorEnd = Math.max(priorEnd, word.endMs);
    }
    markCluster();
    // Never invent ranges or clamp provider drift into unrelated PCM. A single
    // sample's tolerance only accommodates floating-point serialization.
    const sentMs = sentBytes / BYTES_PER_MS;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)
      || endMs <= startMs || startMs >= sentMs || endMs > sentMs + 1 / 16) {
      fail('received timestamps outside the audio stream');
      return;
    }
    const sentences = splitSentences(message.text, words, sentMs);
    if (!sentences) {
      fail('cannot safely align sentence timestamps');
      return;
    }
    for (const utterance of sentences) {
      if (stopped) return;
      const key = JSON.stringify([utterance.startMs, utterance.endMs, utterance.text]);
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > 256) seen.delete(seen.values().next().value!);
      options.onUtterance(utterance);
    }
  }

  const provider: SpeechProvider = {
    sendAudio(pcm) {
      if (stopped || pcm.length === 0) return;
      if (pcm.length % 2 !== 0) {
        fail('requires complete 16-bit PCM samples');
        return;
      }
      if (pending.length + pcm.length > MAX_PENDING_BYTES) {
        fail('audio buffer exceeded five seconds');
        return;
      }
      // Copy caller-owned data before retaining it through async startup.
      pending = Buffer.concat([pending, pcm]);
      flush();
    },
    close() {
      if (closePromise) return closePromise;
      stopped = true; // Suppress late transcripts/errors immediately.
      clearPending();
      closePromise = new Promise<void>((resolve) => { resolveClose = resolve; });
      if (!socket || socket.readyState === WebSocket.CLOSED) {
        finishClose();
      } else {
        closeTimer = setTimeout(() => {
          try { socket?.terminate(); } catch { /* already disconnected */ }
          finishClose();
        }, transport.closeTimeoutMs ?? 1_000);
        try {
          if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
          else socket.close(1000);
        } catch {
          try { socket.terminate(); } catch { /* already disconnected */ }
          finishClose();
        }
      }
      return closePromise;
    },
  };

  const url = new URL('wss://api.elevenlabs.io/v1/speech-to-text/realtime');
  url.search = new URLSearchParams({
    model_id: 'scribe_v2_realtime', audio_format: 'pcm_16000',
    commit_strategy: 'vad', include_timestamps: 'true', no_verbatim: 'false',
    vad_silence_threshold_secs: '0.5', vad_threshold: '0.4',
    min_speech_duration_ms: '100', min_silence_duration_ms: '100',
    keepalive_interval_ms: '1000',
  }).toString();
  if (!options.apiKey.trim()) {
    queueMicrotask(() => fail('requires an API key'));
    return provider;
  }
  try {
    socket = (transport.createWebSocket ?? ((address, config) => new WebSocket(address, config)))(
      url.toString(),
      { headers: { 'xi-api-key': options.apiKey }, maxPayload: 1_048_576,
        handshakeTimeout: transport.connectTimeoutMs ?? 10_000 },
    );
    socket.on('message', onMessage);
    // Keep an error listener attached after shutdown: ws can still emit errors
    // while aborting a CONNECTING socket. fail() suppresses their callbacks.
    socket.on('error', () => fail('connection failed'));
    socket.on('close', () => {
      if (!stopped) fail('connection closed unexpectedly');
      finishClose();
    });
    connectTimer = setTimeout(() => fail('session startup timed out'), transport.connectTimeoutMs ?? 10_000);
  } catch {
    queueMicrotask(() => fail('connection failed'));
  }
  return provider;
}
