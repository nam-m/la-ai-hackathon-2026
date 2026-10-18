import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createDeepgramProvider, type DeepgramOptions, type DeepgramSocket } from '../src/speech/deepgram.js';
import type { ProviderUtterance } from '../src/speech/types.js';

class FakeSocket extends EventEmitter implements DeepgramSocket {
  readyState = 0;
  bufferedAmount = 0;
  sent: (string | Uint8Array)[] = [];
  terminated = false;
  sendError: Error | undefined;
  throwOnSend = false;
  open(): void { this.readyState = 1; this.emit('open'); }
  send(data: string | Uint8Array, callback?: (error?: Error) => void): void {
    if (this.throwOnSend) throw new Error('secret-Deepgram');
    this.sent.push(typeof data === 'string' ? data : Uint8Array.from(data));
    callback?.(this.sendError);
  }
  result(message: unknown): void { this.emit('message', Buffer.from(JSON.stringify(message)), false); }
  close(): void { this.readyState = 3; this.emit('close', 1000, Buffer.alloc(0)); }
  terminate(): void { this.terminated = true; this.close(); }
}

function harness(overrides: Partial<DeepgramOptions> = {}) {
  const socket = new FakeSocket();
  const utterances: ProviderUtterance[] = [];
  const errors: Error[] = [];
  let address = '';
  let settings: { headers: Record<string, string> } | undefined;
  const provider = createDeepgramProvider({
    apiKey: 'secret-Deepgram',
    onUtterance: value => utterances.push(value),
    onError: error => errors.push(error),
    websocketFactory: (url, options) => { address = url; settings = options; return socket; },
    ...overrides,
  });
  const audio = (seconds = 10) => provider.sendAudio(new Uint8Array(seconds * 32_000));
  async function close() {
    const promise = provider.close();
    socket.close();
    await promise;
  }
  return { socket, utterances, errors, provider, audio, close, address, settings };
}

function word(text: string, start: number, end: number, speaker: unknown = 0) {
  return { word: text.toLowerCase().replace(/[?.!,]/g, ''), punctuated_word: text, start, end, speaker };
}

function result(words: ReturnType<typeof word>[], speechFinal = false, other: Record<string, unknown> = {}) {
  const start = words[0]?.start ?? 0;
  const end = words.at(-1)?.end ?? start;
  return {
    type: 'Results', is_final: true, speech_final: speechFinal,
    start, duration: end - start, channel_index: [0, 1],
    channel: { alternatives: [{ transcript: words.map(value => value.punctuated_word).join(' '), words }] },
    ...other,
  };
}

test('Nova-3 connection uses server-only auth and the guide PCM/diarization settings', async () => {
  const h = harness();
  const url = new URL(h.address);
  assert.equal(url.origin, 'wss://api.deepgram.com');
  assert.equal(url.pathname, '/v1/listen');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    model: 'nova-3', encoding: 'linear16', sample_rate: '16000', channels: '1',
    diarize: 'true', interim_results: 'true', endpointing: '300', punctuate: 'true', utterance_end_ms: '1000',
  });
  assert.equal(h.address.includes('secret'), false);
  assert.equal(h.settings?.headers.Authorization, 'Token secret-Deepgram');
  await h.close();
});

test('queues copies until open, splits large audio frames, and preserves all PCM bytes', async () => {
  const h = harness();
  const pcm = new Uint8Array(6400).fill(7);
  h.provider.sendAudio(pcm);
  pcm.fill(99);
  assert.equal(h.socket.sent.length, 0);
  h.socket.open();
  assert.equal(h.socket.sent.length, 2);
  for (const frame of h.socket.sent) {
    assert.ok(frame instanceof Uint8Array);
    assert.equal(frame.length, 3200);
    assert.equal(frame.every(value => value === 7), true);
  }
  assert.equal(h.errors.length, 0);
  await h.close();
});

test('ignores interim transcripts and joins final segments until a speech boundary', async () => {
  const h = harness();
  h.socket.open(); h.audio();
  h.socket.result(result([word('Wrong?', 0, 0.2)], true, { is_final: false }));
  h.socket.result(result([word('What', 0.1, 0.3), word('time', 0.3, 0.6)]));
  assert.deepEqual(h.utterances, []);
  h.socket.result(result([word('is', 0.7, 0.8), word('lunch?', 0.8, 1.1)], true));
  assert.deepEqual(h.utterances, [{ text: 'What time is lunch?', startMs: 100, endMs: 1100, speaker: '0' }]);
  await h.close();
});

test('preserves actual speaker turns within and across finalized segments', async () => {
  const h = harness();
  h.socket.open(); h.audio();
  h.socket.result(result([word('Lunch?', 0, 0.4, 0), word('At', 0.5, 0.7, 1)]));
  h.socket.result(result([word('noon.', 0.7, 1, 1), word('Thanks.', 1.2, 1.5, 0)], true));
  assert.deepEqual(h.utterances, [
    { text: 'Lunch?', startMs: 0, endMs: 400, speaker: '0' },
    { text: 'At noon.', startMs: 500, endMs: 1000, speaker: '1' },
    { text: 'Thanks.', startMs: 1200, endMs: 1500, speaker: '0' },
  ]);
  await h.close();
});

test('splits one speaker question and following statement into distinct sentence ranges', async () => {
  const h = harness();
  h.socket.open(); h.audio();
  h.socket.result(result([word('When', 0.1, 0.3, 0), word('is', 0.3, 0.4, 0)]));
  h.socket.result(result([
    word('lunch?', 0.4, 0.7, 0), word('I', 0.8, 0.9, 0),
    word('am', 0.9, 1, 0), word('hungry.', 1, 1.3, 0),
  ], true));
  assert.deepEqual(h.utterances, [
    { text: 'When is lunch?', startMs: 100, endMs: 700, speaker: '0' },
    { text: 'I am hungry.', startMs: 800, endMs: 1300, speaker: '0' },
  ]);
  assert.equal(h.utterances.map(value => value.text).join(' '), 'When is lunch? I am hungry.');
  await h.close();
});

test('splits sentences ending with quoted punctuation while preserving recognized words', async () => {
  const h = harness();
  h.socket.open(); h.audio();
  h.socket.result(result([
    word('"Noon!"', 0.1, 0.4, 1), word('Then', 0.5, 0.7, 1),
    word('we', 0.7, 0.8, 1), word('leave.', 0.8, 1, 1),
    word('Okay?', 1.1, 1.3, 0),
  ], true));
  assert.deepEqual(h.utterances, [
    { text: '"Noon!"', startMs: 100, endMs: 400, speaker: '1' },
    { text: 'Then we leave.', startMs: 500, endMs: 1000, speaker: '1' },
    { text: 'Okay?', startMs: 1100, endMs: 1300, speaker: '0' },
  ]);
  await h.close();
});

test('duplicate final segments and repeated boundary events never duplicate utterances', async () => {
  const h = harness();
  h.socket.open(); h.audio();
  const segment = result([word('Where?', 0.1, 0.5)]);
  h.socket.result(segment); h.socket.result(segment);
  h.socket.result({ ...segment, speech_final: true });
  h.socket.result({ ...segment, speech_final: true });
  h.socket.result({ type: 'UtteranceEnd', last_word_end: 0.5 });
  assert.equal(h.utterances.length, 1);
  assert.equal(h.utterances[0]?.text, 'Where?');
  await h.close();
});

test('UtteranceEnd flushes only the stated range and ignores -1/stale boundaries', async () => {
  const h = harness();
  h.socket.open(); h.audio();
  h.socket.result(result([word('First.', 0.1, 0.4)]));
  h.socket.result(result([word('Second.', 1.1, 1.4)]));
  h.socket.result({ type: 'UtteranceEnd', last_word_end: -1 });
  assert.equal(h.utterances.length, 0);
  h.socket.result({ type: 'UtteranceEnd', last_word_end: 0.4 });
  h.socket.result({ type: 'UtteranceEnd', last_word_end: 0.4 });
  assert.deepEqual(h.utterances.map(value => value.text), ['First.']);
  h.socket.result({ type: 'UtteranceEnd', last_word_end: 1.4 });
  assert.deepEqual(h.utterances.map(value => value.text), ['First.', 'Second.']);
  await h.close();
});

test('empty final speech boundary emits earlier final text', async () => {
  const h = harness();
  h.socket.open(); h.audio();
  h.socket.result(result([word('Hello.', 0.1, 0.4)]));
  h.socket.result(result([], true, { start: 0.4, duration: 0.3 }));
  assert.equal(h.utterances[0]?.text, 'Hello.');
  await h.close();
});

test('unknown or malformed speaker labels remain null without borrowing nearby identity', async () => {
  const h = harness();
  h.socket.open(); h.audio();
  h.socket.result(result([
    word('Known.', 0, 0.2, 0), word('Unknown.', 0.3, 0.5, 'Sarah'),
    word('Still unknown.', 0.6, 0.8, -1), word('Known again.', 0.9, 1.2, 1),
  ], true));
  assert.deepEqual(h.utterances.map(value => value.speaker), ['0', null, null, '1']);
  h.socket.result({ type: 'Results', is_final: true, speech_final: true, start: 2, duration: 0.5,
    channel: { alternatives: [{ transcript: 'No word metadata.', words: [] }] } });
  assert.deepEqual(h.utterances.at(-1), { text: 'No word metadata.', startMs: 2000, endMs: 2500, speaker: null, uncertain: true });
  await h.close();
});

test('mixed labels inside a single sentence retain text but cannot be confidently attributed', async () => {
  const h = harness();
  h.socket.open(); h.audio();
  h.socket.result(result([word('Lunch', 0.1, 0.3, 0), word('is', 0.3, 0.5, 1), word('noon.', 0.5, 0.8, 1)], true));
  assert.deepEqual(h.utterances, [
    { text: 'Lunch', startMs: 100, endMs: 300, speaker: '0', uncertain: true },
    { text: 'is noon.', startMs: 300, endMs: 800, speaker: '1', uncertain: true },
  ]);
  await h.close();
});

test('overlapping nested words across final segments are retained and marked uncertain', async () => {
  const h = harness();
  h.socket.open(); h.audio();
  h.socket.result(result([word('Never', 0.1, 0.8, 0)]));
  h.socket.result(result([word('go', 0.2, 0.4, 1), word('there.', 0.8, 1, 0)], true));
  assert.deepEqual(h.utterances, [
    { text: 'Never', startMs: 100, endMs: 800, speaker: '0', uncertain: true },
    { text: 'go', startMs: 200, endMs: 400, speaker: '1', uncertain: true },
    { text: 'there.', startMs: 800, endMs: 1000, speaker: '0', uncertain: true },
  ]);
  assert.equal(h.errors.length, 0);
  await h.close();
});

test('overlap across punctuation marks both sentences uncertain and preserves maximum end time', async () => {
  const h = harness();
  h.socket.open(); h.audio();
  h.socket.result(result([word('When?', 0.1, 0.8, 0), word('Noon.', 0.4, 1, 1)], true));
  assert.equal(h.utterances.length, 2);
  assert.ok(h.utterances.every(value => value.uncertain));
  assert.equal(h.utterances[0]?.endMs, 800);
  await h.close();
});

test('honorific abbreviations do not split or truncate an answer', async () => {
  const h = harness();
  h.socket.open(); h.audio();
  h.socket.result(result([word('Ask', 0.1, 0.2), word('Dr.', 0.2, 0.4), word('Smith.', 0.4, 0.8)], true));
  assert.deepEqual(h.utterances, [{ text: 'Ask Dr. Smith.', startMs: 100, endMs: 800, speaker: '0' }]);
  await h.close();
});

test('final word rounding up to 20 ms clamps to sent PCM; larger drift is dropped, not fatal', async () => {
  const good = harness();
  good.socket.open(); good.audio(1);
  good.socket.result(result([word('Okay.', 0.1, 1.015)], true));
  assert.equal(good.utterances[0]?.endMs, 1000);
  assert.equal(good.errors.length, 0);
  await good.close();
  const bad = harness();
  bad.socket.open(); bad.audio(1);
  bad.socket.result(result([word('Drift.', 0.1, 1.03)], true));
  assert.equal(bad.utterances.length, 0);
  assert.equal(bad.errors.length, 0);
  assert.equal(bad.socket.terminated, false);
  await bad.close();
});

test('a reentrant terminal failure while emitting stops the remaining final sentences', async () => {
  const delivered: ProviderUtterance[] = [];
  const h = harness({ onUtterance(value) {
    delivered.push(value);
    h.provider.sendAudio(new Uint8Array(3));
  } });
  h.socket.open(); h.audio();
  h.socket.result(result([word('First.', 0.1, 0.4), word('Second.', 0.5, 0.8)], true));
  assert.equal(delivered.length, 1);
  assert.equal(h.errors.length, 1);
  await h.close();
});

test('skips reversed or zero-length word timing without failing the connection', async () => {
  const h = harness();
  h.socket.open(); h.audio();
  h.socket.result(result([word('secret-Deepgram', 1, 0.5)], true));
  h.socket.result(result([word('Blip', 0.2, 0.2), word('Okay.', 0.3, 0.6)], true));
  assert.deepEqual(h.utterances.map(u => u.text), ['Okay.']);
  assert.equal(h.errors.length, 0);
  assert.equal(h.socket.terminated, false);
  await h.close();
});

test('drops a final with timestamps outside sent PCM and keeps transcribing', async () => {
  const h = harness();
  h.socket.open(); h.audio(1);
  h.socket.result(result([word('Impossible.', 4, 5)], true));
  h.socket.result(result([word('Late.', 0, 0.3)], true));
  assert.equal(h.errors.length, 0);
  assert.deepEqual(h.utterances.map(u => u.text), ['Late.']);
  await h.close();
});

test('preopen queue, sample alignment, and transport backpressure fail without reconnecting', async () => {
  const queued = harness({ maxQueuedBytes: 640 });
  queued.provider.sendAudio(new Uint8Array(642));
  assert.match(queued.errors[0]!.message, /queue limit/);
  assert.equal(queued.socket.terminated, true);
  await queued.close();

  const aligned = harness();
  aligned.socket.open(); aligned.provider.sendAudio(new Uint8Array(3));
  assert.match(aligned.errors[0]!.message, /16-bit/);
  await aligned.close();

  const blocked = harness({ maxBufferedBytes: 640 });
  blocked.socket.open(); blocked.socket.bufferedAmount = 500;
  blocked.provider.sendAudio(new Uint8Array(640));
  assert.match(blocked.errors[0]!.message, /backpressure/);
  assert.equal(blocked.socket.sent.length, 0);
  await blocked.close();
});

test('send errors and provider/transport errors are credential-safe and reported once', async () => {
  for (const mode of ['send-callback', 'send-throw', 'service', 'socket', 'close', 'handshake', 'json']) {
    const h = harness();
    h.socket.open();
    if (mode === 'send-callback') { h.socket.sendError = new Error('secret-Deepgram'); h.audio(0.02); }
    if (mode === 'send-throw') { h.socket.throwOnSend = true; h.audio(0.02); }
    if (mode === 'service') h.socket.result({ type: 'Error', description: 'secret-Deepgram' });
    if (mode === 'socket') h.socket.emit('error', new Error('secret-Deepgram'));
    if (mode === 'close') h.socket.close();
    if (mode === 'handshake') h.socket.emit('unexpected-response', null, { resume() {} });
    if (mode === 'json') h.socket.emit('message', Buffer.from('secret-Deepgram'), false);
    h.socket.emit('error', new Error('secret-Deepgram'));
    assert.equal(h.errors.length, 1, mode);
    assert.equal(h.errors[0]!.message.includes('secret'), false, mode);
    await h.close();
  }
});

test('KeepAlive is a text control frame and stops after close', async () => {
  const h = harness({ keepAliveMs: 5 });
  h.socket.open();
  await delay(18);
  assert.ok(h.socket.sent.includes('{"type":"KeepAlive"}'));
  assert.equal(h.socket.sent.every(value => typeof value === 'string'), true);
  await h.close();
  const count = h.socket.sent.length;
  await delay(12);
  assert.equal(h.socket.sent.length, count);
});

test('close is idempotent, requests finalization, accepts trailing finals, and ignores later audio', async () => {
  const h = harness();
  h.socket.open(); h.audio();
  h.socket.result(result([word('One', 0, 0.2)]));
  const closing = h.provider.close();
  assert.equal(h.provider.close(), closing);
  assert.equal(h.socket.sent.at(-1), '{"type":"CloseStream"}');
  const before = h.socket.sent.length;
  h.audio();
  assert.equal(h.socket.sent.length, before);
  h.socket.result(result([word('two.', 0.3, 0.6)], false, { from_finalize: true }));
  h.socket.close();
  await closing;
  assert.deepEqual(h.utterances.map(value => value.text), ['One two.']);
  h.socket.result(result([word('Late.', 0.7, 0.9)], true));
  assert.equal(h.utterances.length, 1);
  assert.equal(h.errors.length, 0);
});

test('connect and close deadlines settle instead of leaving a hanging provider', async () => {
  const connecting = harness({ connectTimeoutMs: 5 });
  await delay(15);
  assert.match(connecting.errors[0]!.message, /timed out/);
  assert.equal(connecting.socket.terminated, true);
  await connecting.close();

  const closing = harness({ closeTimeoutMs: 5 });
  closing.socket.open(); closing.audio(1);
  closing.socket.result(result([word('Final.', 0.1, 0.4)]));
  const promise = closing.provider.close();
  await delay(15); await promise;
  assert.equal(closing.socket.terminated, true);
  assert.equal(closing.utterances[0]?.text, 'Final.');
  assert.equal(closing.errors.length, 0);
});

test('missing credentials and construction failures are reported without exposing secrets', async () => {
  const missing = harness({ apiKey: ' ' });
  await delay(0);
  assert.match(missing.errors[0]!.message, /API key is required/);
  await missing.close();
  const failed = harness({ websocketFactory: () => { throw new Error('secret-Deepgram'); } });
  await delay(0);
  assert.equal(failed.errors.length, 1);
  assert.equal(failed.errors[0]?.message.includes('secret'), false);
  await failed.close();
});
