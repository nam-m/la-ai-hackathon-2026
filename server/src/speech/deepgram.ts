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
    const ready = pending.filter(word => word.endMs <= throughMs + 0.01);
    pending = pending.filter(word => word.endMs > throughMs + 0.01);
    let turn: ProviderUtterance | undefined;
    for (const word of ready) {
      if (turn && turn.speaker === word.speaker) {
        turn.text += ` ${word.text}`;
        turn.endMs = word.endMs;
      } else {
        if (turn) options.onUtterance(turn);
        turn = { ...word };
      }
      // A single speaker can ask a question and continue with another sentence
      // before endpointing fires. Preserve each sentence's own word timestamps
      // so downstream pairing sees the next sentence as a distinct utterance.
      if (/[.!?]["'\u201d\u2019)\]}\u00bb]*$/u.test(word.text)) {
        options.onUtterance(turn);
        turn = undefined;
      }
    }
    if (turn) options.onUtterance(turn);
  }

  function parseFinal(message: JsonObject): { tokens: Token[]; endMs: number } | null {
    if (!object(message.channel) || !Array.isArray(message.channel.alternatives)) return null;
    const alternative: unknown = message.channel.alternatives[0];
    if (!object(alternative) || typeof alternative.transcript !== 'string') return null;
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
        tokens.push({
          text,
          startMs: word.start * 1000,
          endMs: word.end * 1000,
          speaker: typeof word.speaker === 'number' && Number.isSafeInteger(word.speaker) && word.speaker >= 0
            ? String(word.speaker) : null,
        });
      }
    } else if (alternative.transcript.trim()) {
      if (rangeStart === undefined || rangeEnd === undefined || rangeEnd <= rangeStart) return null;
      // No word diarization means unknown identity, even if another segment had a label.
      tokens.push({ text: alternative.transcript.trim(), startMs: rangeStart, endMs: rangeEnd, speaker: null });
    }
    const endMs = rangeEnd ?? tokens.at(-1)?.endMs;
    if (endMs === undefined || !Number.isFinite(endMs) || endMs > sentBytes / 32 + 1) return null;
    if (tokens.some(word => word.endMs > sentBytes / 32 + 1)) return null;
    return { tokens, endMs };
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
    // Final Results are chronological, non-overlapping audio ranges. The high
    // water mark also suppresses replayed finals after their buffer was emitted.
    const fresh = final.tokens.filter(word => word.endMs > acceptedEndMs + 0.01);
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
