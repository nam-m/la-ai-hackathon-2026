import WebSocket from 'ws';
import type { ProviderOptions, ProviderUtterance, SpeechProvider } from './types.js';

/** Small transport surface so tests never need credentials or a network. */
export interface DeepgramSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  on(event: string, listener: (...args: any[]) => void): unknown;
  send(data: string | Uint8Array, callback?: (error?: Error) => void): void;
  close(): void;
  terminate(): void;
}

export type DeepgramWebSocketFactory = (
  url: string,
  options: { headers: Record<string, string>; handshakeTimeout: number; maxPayload: number },
) => DeepgramSocket;

export type DeepgramOptions = ProviderOptions & {
  websocketFactory?: DeepgramWebSocketFactory;
  connectTimeoutMs?: number;
  closeTimeoutMs?: number;
  keepAliveMs?: number;
  maxQueuedBytes?: number;
  maxBufferedBytes?: number;
};

type Token = ProviderUtterance;
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const seconds = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const SAMPLE_MS = 1 / 16;
const SENTENCE_END = /[.!?]["'\u201d\u2019)\]}\u00bb]*$/u;
const ABBREVIATION = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|vs|e\.g|i\.e)\.|^(?:[A-Z]\.)+)$/iu;

/**
 * Nova-3, raw signed little-endian 16-bit PCM / 16 kHz / mono.
 * https://developers.deepgram.com/reference/speech-to-text/listen-streaming
 * https://developers.deepgram.com/docs/understand-endpointing-interim-results
 * https://developers.deepgram.com/docs/utterance-end
 * https://developers.deepgram.com/docs/audio-keep-alive
 *
 * Only finalized words are accumulated. Provider labels are connection-local;
 * this adapter does not infer names or a wearer, and never reconnects itself.
 */
export function createDeepgramProvider(options: DeepgramOptions): SpeechProvider {
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  const closeTimeoutMs = options.closeTimeoutMs ?? 2_000;
  const keepAliveMs = options.keepAliveMs ?? 4_000;
  const maxQueuedBytes = options.maxQueuedBytes ?? 160_000; // five seconds of PCM
  const maxBufferedBytes = options.maxBufferedBytes ?? 256_000;
  let socket: DeepgramSocket | undefined;
  let state: 'connecting' | 'open' | 'closing' | 'closed' | 'failed' = 'connecting';
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
  let queue: Uint8Array[] = [];
  let queuedBytes = 0;
  let sentBytes = 0;
  let pending: Token[] = [];
  let acceptedEndMs = -1;
  let emittedEndMs = -1;
  const seenWords = new Set<string>();
  let closePromise: Promise<void> | undefined;
  let resolveClose: (() => void) | undefined;

  function clearTimers(): void {
    clearTimeout(connectTimer);
    clearTimeout(closeTimer);
    clearInterval(keepAliveTimer);
  }

  function discard(): void {
    queue = [];
    queuedBytes = 0;
    pending = [];
    seenWords.clear();
  }

  // Deliberately do not forward provider text, exception messages, headers, or
  // close reasons: those may contain credentials and private transcripts.
  function fail(message: string): void {
    if (state === 'failed' || state === 'closed') return;
    state = 'failed';
    clearTimers();
    discard();
    try { socket?.terminate(); } catch { /* already disconnected */ }
    resolveClose?.();
    options.onError(new Error(message));
  }

  function send(data: string | Uint8Array): boolean {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      fail('Deepgram connection is not open');
      return false;
    }
    const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
    if (socket.bufferedAmount + bytes > maxBufferedBytes) {
      fail('Deepgram audio backpressure limit exceeded');
      return false;
    }
    try {
      if (typeof data !== 'string') sentBytes += bytes;
      socket.send(data, error => {
        if (error) fail('Deepgram audio send failed');
      });
      return state !== 'failed';
    } catch {
      fail('Deepgram audio send failed');
      return false;
    }
  }

  function flush(throughMs = Infinity): void {
    const terminal = () => state === 'failed' || state === 'closed';
    // Overlapping timestamps are evidence that a single RMS range cannot
    // safely identify the voice. Mark the whole connected overlap, including
    // intervals nested inside an earlier word rather than dropping that word.
    let cluster: Token[] = [];
    let clusterEnd = -1;
    const finishCluster = () => {
      if (cluster.length > 1) for (const word of cluster) word.uncertain = true;
    };
    for (const word of [...pending].sort((a, b) => a.startMs - b.startMs)) {
      if (word.startMs >= clusterEnd - SAMPLE_MS) { finishCluster(); cluster = []; }
      cluster.push(word);
      clusterEnd = Math.max(clusterEnd, word.endMs);
    }
    finishCluster();
    const firstLater = pending.findIndex(word => word.endMs > throughMs + 0.01);
    const count = firstLater < 0 ? pending.length : firstLater;
    // A delayed boundary inside an overlap must not pull a short later word
    // ahead of an earlier word whose timestamp still extends past the cutoff.
    const ready = pending.slice(0, count);
    pending = pending.slice(count);
    let sentence: Token[] = [];
    function emitSentence(): boolean {
      const uncertain = sentence.some(word => word.uncertain) || new Set(sentence.map(word => word.speaker)).size > 1;
      let turn: ProviderUtterance | undefined;
      const emitTurn = (): boolean => {
        if (!turn) return true;
        if (terminal()) return false;
        emittedEndMs = Math.max(emittedEndMs, turn.endMs);
        options.onUtterance(turn);
        return !terminal();
      };
      for (const word of sentence) {
        if (turn && turn.speaker === word.speaker) {
          turn.text += ` ${word.text}`;
          turn.endMs = Math.max(turn.endMs, word.endMs);
        } else {
          if (!emitTurn()) return false;
          turn = { ...word, ...(uncertain ? { uncertain: true } : {}) };
        }
      }
      sentence = [];
      return emitTurn();
    }
    for (let index = 0; index < ready.length; index++) {
      const word = ready[index]!;
      sentence.push(word);
      const next = ready[index + 1];
      const abbreviation = next?.speaker === word.speaker && ABBREVIATION.test(word.text);
      if (SENTENCE_END.test(word.text) && !abbreviation && !emitSentence()) return;
    }
    if (sentence.length) emitSentence();
  }

  function remember(word: Token): boolean {
    const key = `${word.startMs}:${word.endMs}:${word.speaker}`;
    if (seenWords.has(key) || word.endMs < acceptedEndMs - 120_000) return false;
    seenWords.add(key);
    if (seenWords.size > 20_000) seenWords.delete(seenWords.values().next().value!);
    // A late overlapping final cannot be confidently classified using either
    // a diarization label or an RMS range already attributed to another turn.
    if (word.startMs < emittedEndMs - SAMPLE_MS) word.uncertain = true;
    return true;
  }

  function parseFinal(message: JsonObject): { tokens: Token[]; endMs: number } | null {
    if (!object(message.channel) || !Array.isArray(message.channel.alternatives)) return null;
    const alternative: unknown = message.channel.alternatives[0];
    if (!object(alternative) || typeof alternative.transcript !== 'string') return null;
    if ((message.start !== undefined && !seconds(message.start)) ||
      (message.duration !== undefined && !seconds(message.duration))) return null;
    const hasRange = seconds(message.start) && seconds(message.duration);
    const rangeStart = hasRange ? (message.start as number) * 1000 : undefined;
    const rangeEnd = hasRange ? rangeStart! + (message.duration as number) * 1000 : undefined;
    const tokens: Token[] = [];
    if (Array.isArray(alternative.words) && alternative.words.length > 0) {
      for (const word of alternative.words) {
        if (!object(word) || !seconds(word.start) || !seconds(word.end) || word.end <= word.start) return null;
        const text = typeof word.punctuated_word === 'string' && word.punctuated_word.trim()
          ? word.punctuated_word.trim()
          : typeof word.word === 'string' ? word.word.trim() : '';
        if (!text) return null;
        const previous = tokens.at(-1);
        if (previous && word.start * 1000 < previous.startMs) return null;
        const speaker = typeof word.speaker === 'number' && Number.isSafeInteger(word.speaker) && word.speaker >= 0
          ? String(word.speaker) : null;
        tokens.push({
          text,
          startMs: word.start * 1000,
          endMs: word.end * 1000,
          speaker,
          ...(speaker === null ? { uncertain: true } : {}),
        });
      }
    } else if (alternative.transcript.trim()) {
      if (rangeStart === undefined || rangeEnd === undefined || rangeEnd <= rangeStart) return null;
      // No word diarization means unknown identity, even if another segment had a label.
      tokens.push({ text: alternative.transcript.trim(), startMs: rangeStart, endMs: rangeEnd, speaker: null, uncertain: true });
    }
    const maxWordEnd = tokens.reduce((end, word) => Math.max(end, word.endMs), -Infinity);
    const endMs = rangeEnd ?? (tokens.length ? maxWordEnd : undefined);
    const sentMs = sentBytes / 32;
    if (endMs === undefined || !Number.isFinite(endMs) || endMs > sentMs + SAMPLE_MS) return null;
    if (tokens.some(word => word.startMs >= sentMs || word.endMs > Math.min(endMs, sentMs) + SAMPLE_MS)) return null;
    for (const word of tokens) word.endMs = Math.min(word.endMs, sentMs);
    return { tokens, endMs: Math.min(Math.max(endMs, maxWordEnd), sentMs) };
  }

  function onMessage(data: unknown, isBinary?: boolean): void {
    if (state === 'failed' || state === 'closed') return;
    if (isBinary) { fail('Deepgram returned an unexpected binary response'); return; }
    let message: unknown;
    try {
      const value = typeof data === 'string' ? data :
        Buffer.isBuffer(data) ? data.toString('utf8') :
        data instanceof ArrayBuffer ? Buffer.from(data).toString('utf8') : '';
      message = JSON.parse(value);
    } catch { fail('Deepgram returned invalid JSON'); return; }
    if (!object(message)) { fail('Deepgram returned an invalid response'); return; }
    if (message.type === 'Error') { fail('Deepgram transcription service reported an error'); return; }
    if (message.type === 'UtteranceEnd') {
      // -1 means an already-finalized/stale boundary. A delayed boundary must
      // never flush later words that belong to the next utterance.
      if (seconds(message.last_word_end)) flush(message.last_word_end * 1000);
      return;
    }
    if (message.type !== 'Results' || message.is_final !== true) return;
    if (Array.isArray(message.channel_index) && message.channel_index[0] !== 0) return;
    const final = parseFinal(message);
    if (!final) { fail('Deepgram returned a malformed final transcript'); return; }
    // Exact timing/label deduplication preserves genuinely overlapping words;
    // an end-time high-water filter would silently discard nested intervals.
    const fresh = final.tokens.filter(remember);
    pending.push(...fresh);
    if (fresh.length) acceptedEndMs = Math.max(acceptedEndMs, ...fresh.map(word => word.endMs));
    if (pending.length > 10_000 || (pending.length && pending.at(-1)!.endMs - pending[0]!.startMs > 120_000)) {
      fail('Deepgram utterance exceeded the buffering limit');
      return;
    }
    if (message.speech_final === true || message.from_finalize === true) flush(final.endMs);
  }

  const provider: SpeechProvider = {
    sendAudio(pcm): void {
      if (state !== 'connecting' && state !== 'open') return;
      if (pcm.byteLength % 2 !== 0) { fail('Deepgram requires complete 16-bit PCM samples'); return; }
      if (!pcm.byteLength) return;
      if (state === 'connecting') {
        if (queuedBytes + pcm.byteLength > maxQueuedBytes) {
          fail('Deepgram connection audio queue limit exceeded');
          return;
        }
        queue.push(Uint8Array.from(pcm));
        queuedBytes += pcm.byteLength;
        return;
      }
      // At most 100 ms per frame. The speech module normally supplies 20 ms
      // chunks; short final tails are allowed so no PCM samples are dropped.
      for (let offset = 0; offset < pcm.byteLength; offset += 3200) {
        if (!send(pcm.subarray(offset, offset + 3200))) break;
      }
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      if (state === 'failed' || state === 'closed') return Promise.resolve();
      closePromise = new Promise(resolve => { resolveClose = resolve; });
      const wasOpen = state === 'open';
      state = 'closing';
      clearTimers();
      queue = [];
      queuedBytes = 0;
      if (!wasOpen) {
        state = 'closed';
        discard();
        try { socket?.terminate(); } catch { /* already disconnected */ }
        resolveClose?.();
      } else {
        // CloseStream requests final results before the server closes. A forced
        // deadline prevents pause/close from hanging on a broken connection.
        closeTimer = setTimeout(() => {
          if (state !== 'closing') return;
          flush();
          state = 'closed';
          clearTimers();
          discard();
          try { socket?.terminate(); } catch { /* already disconnected */ }
          resolveClose?.();
        }, closeTimeoutMs);
        closeTimer.unref?.();
        send(JSON.stringify({ type: 'CloseStream' }));
      }
      return closePromise;
    },
  };

  if (!options.apiKey.trim()) {
    queueMicrotask(() => fail('Deepgram API key is required'));
    return provider;
  }
  try {
    const url = new URL('wss://api.deepgram.com/v1/listen');
    url.search = new URLSearchParams({
      model: 'nova-3', encoding: 'linear16', sample_rate: '16000', channels: '1',
      diarize: 'true', interim_results: 'true', endpointing: '300',
      punctuate: 'true', utterance_end_ms: '1000',
    }).toString();
    const factory = options.websocketFactory ?? ((address, settings) => new WebSocket(address, settings));
    socket = factory(url.toString(), {
      headers: { Authorization: `Token ${options.apiKey}` },
      handshakeTimeout: connectTimeoutMs,
      maxPayload: 1_048_576,
    });
    socket.on('error', () => fail('Deepgram WebSocket connection failed'));
    socket.on('unexpected-response', (_request: unknown, response: { resume?: () => void }) => {
      response?.resume?.();
      fail('Deepgram WebSocket handshake was rejected');
    });
    socket.on('message', onMessage);
    socket.on('close', () => {
      if (state === 'failed' || state === 'closed') return;
      if (state !== 'closing') { fail('Deepgram WebSocket closed unexpectedly'); return; }
      flush();
      state = 'closed';
      clearTimers();
      discard();
      resolveClose?.();
    });
    socket.on('open', () => {
      if (state !== 'connecting') return;
      state = 'open';
      clearTimeout(connectTimer);
      const buffered = queue;
      queue = [];
      queuedBytes = 0;
      for (const pcm of buffered) {
        provider.sendAudio(pcm);
        if (state !== 'open') break;
      }
      if (state !== 'open') return;
      // KeepAlive is a JSON text frame, never PCM/binary and never a ws ping.
      keepAliveTimer = setInterval(() => { if (state === 'open') send('{"type":"KeepAlive"}'); }, keepAliveMs);
      keepAliveTimer.unref?.();
    });
    connectTimer = setTimeout(() => fail('Deepgram connection timed out'), connectTimeoutMs);
    connectTimer.unref?.();
  } catch {
    // Defer construction failures to keep ProviderFactory initialization atomic.
    queueMicrotask(() => fail('Deepgram WebSocket initialization failed'));
  }
  return provider;
}
