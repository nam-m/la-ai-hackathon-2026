import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import { test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { createElevenLabsProvider } from '../src/speech/elevenlabs.js';
import { createSpeechModule } from '../src/speech/index.js';
import type { ProviderUtterance, QAPair, Utterance } from '../src/speech/types.js';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: string[] = [];
  terminated = false;
  sendError = false;
  send(text: string, callback: (error?: Error) => void): void {
    if (this.sendError) callback(new Error('SECRET'));
    else { this.sent.push(text); callback(); }
  }
  close(): void { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  terminate(): void { this.terminated = true; this.close(); }
  message(message: unknown): void { this.emit('message', Buffer.from(JSON.stringify(message))); }
}

function setup(connectTimeoutMs = 1_000) {
  const socket = new FakeSocket();
  const utterances: ProviderUtterance[] = [];
  const errors: Error[] = [];
  let capturedUrl = '';
  let headers: unknown;
  const provider = createElevenLabsProvider({
    apiKey: 'SECRET', onUtterance: (u) => utterances.push(u), onError: (e) => errors.push(e),
  }, {
    createWebSocket: (url, options) => {
      capturedUrl = url;
      headers = options.headers;
      return socket as unknown as WebSocket;
    }, connectTimeoutMs, closeTimeoutMs: 10,
  });
  return { socket, provider, utterances, errors, url: new URL(capturedUrl), headers };
}

const transcript = (text = ' Lunch is at noon. ', start = 0.1, end = 0.8) => ({
  message_type: 'committed_transcript_with_timestamps', text,
  words: [{ text: 'Lunch', type: 'word', start, end }],
});

test('ElevenLabs uses server auth, PCM16/VAD, 100ms frames and copied startup audio', async () => {
  const { provider, socket, url, headers, errors } = setup();
  try {
    assert.equal(url.origin, 'wss://api.elevenlabs.io');
    assert.equal(url.searchParams.get('model_id'), 'scribe_v2_realtime');
    assert.equal(url.searchParams.get('audio_format'), 'pcm_16000');
    assert.equal(url.searchParams.get('commit_strategy'), 'vad');
    assert.equal(url.searchParams.get('include_timestamps'), 'true');
    assert.equal(url.searchParams.get('no_verbatim'), 'false');
    assert.equal(url.searchParams.has('token'), false);
    assert.deepEqual(headers, { 'xi-api-key': 'SECRET' });
    const pcm = new Uint8Array(1_600).fill(7);
    provider.sendAudio(pcm);
    pcm.fill(99);
    provider.sendAudio(new Uint8Array(1_600).fill(8));
    assert.equal(socket.sent.length, 0);
    socket.message({ message_type: 'session_started' });
    assert.equal(socket.sent.length, 1);
    const frame = JSON.parse(socket.sent[0]!);
    assert.equal(frame.message_type, 'input_audio_chunk');
    assert.equal(frame.sample_rate, 16_000);
    assert.equal(frame.commit, false);
    const audio = Buffer.from(frame.audio_base_64, 'base64');
    assert.equal(audio.length, 3_200);
    assert.equal(audio[0], 7);
    assert.equal(audio[1_600], 8);
    // Continuous silence reaches VAD unchanged.
    provider.sendAudio(new Uint8Array(3_200));
    assert.deepEqual(Buffer.from(JSON.parse(socket.sent[1]!).audio_base_64, 'base64'), Buffer.alloc(3_200));
    assert.deepEqual(errors, []);
  } finally { await provider.close(); }
});

test('ElevenLabs emits only timestamped commits verbatim and deduplicates by range', async () => {
  const { provider, socket, utterances, errors } = setup();
  try {
    socket.message({ message_type: 'session_started' });
    provider.sendAudio(new Uint8Array(64_000));
    socket.message({ message_type: 'partial_transcript', text: 'Lunch' });
    socket.message({ message_type: 'committed_transcript', text: ' Lunch is at noon. ' });
    socket.message({ message_type: 'edited_transcript', text: 'Lunch', edited_text: 'Never use this' });
    assert.deepEqual(utterances, []);
    socket.message(transcript());
    socket.message(transcript());
    socket.message(transcript(' Lunch is at noon. ', 1.1, 1.8));
    assert.deepEqual(utterances, [
      { text: 'Lunch is at noon.', startMs: 100, endMs: 800, speaker: null },
      { text: 'Lunch is at noon.', startMs: 1_100, endMs: 1_800, speaker: null },
    ]);
    assert.deepEqual(errors, []);
  } finally { await provider.close(); }
});

const combinedCommit = {
  message_type: 'committed_transcript_with_timestamps',
  text: '  What time is lunch?  Lunch is at noon.  ',
  words: [
    { type: 'word', text: 'What', start: 0.1, end: 0.2 },
    { type: 'spacing', text: ' ' },
    { type: 'word', text: 'time', start: 0.2, end: 0.4 },
    { type: 'word', text: 'is', start: 0.4, end: 0.5 },
    { type: 'word', text: 'lunch?', start: 0.5, end: 0.8 },
    { type: 'spacing', text: '  ' },
    { type: 'word', text: 'Lunch', start: 1.1, end: 1.2 },
    { type: 'word', text: 'is', start: 1.2, end: 1.3 },
    { type: 'word', text: 'at', start: 1.3, end: 1.4 },
    { type: 'word', text: 'noon.', start: 1.4, end: 1.8 },
  ],
};

test('ElevenLabs splits a committed Q/A into exact sentences and deduplicates each range', async () => {
  const { provider, socket, errors, utterances } = setup();
  try {
    socket.message({ message_type: 'session_started' });
    provider.sendAudio(new Uint8Array(64_000));
    socket.message(combinedCommit);
    socket.message(combinedCommit);
    assert.deepEqual(errors, []);
    assert.deepEqual(utterances, [
      { text: 'What time is lunch?', startMs: 100, endMs: 800, speaker: null },
      { text: 'Lunch is at noon.', startMs: 1_100, endMs: 1_800, speaker: null },
    ]);
  } finally { await provider.close(); }
});

test('ElevenLabs sentence ranges produce separate wearer/question and other/answer RMS in the core', async () => {
  const socket = new FakeSocket();
  const errors: Error[] = [];
  const utterances: Utterance[] = [];
  const questions: Utterance[] = [];
  const pairs: QAPair[] = [];
  const speech = createSpeechModule({
    provider: 'elevenlabs', apiKey: 'local-key', wearerThresholdDb: -20,
    onError: (e) => errors.push(e), onUtterance: (u) => utterances.push(u),
    onWearerQuestion: (u) => questions.push(u), onPair: (pair) => pairs.push(pair),
    providerFactory: (options) => createElevenLabsProvider(options, {
      createWebSocket: () => socket as unknown as WebSocket,
    }),
  });
  const audio = (amplitude: number) => {
    const pcm = Buffer.alloc(32_000);
    for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(amplitude, i);
    return pcm;
  };
  try {
    speech.pushAudio(audio(10_000)); // Wearer: approximately -10 dBFS.
    speech.pushAudio(audio(1_000)); // Other: approximately -30 dBFS.
    socket.message({ message_type: 'session_started' });
    socket.message(combinedCommit);
    socket.message(combinedCommit);
    assert.deepEqual(errors, []);
    assert.equal(utterances.length, 2);
    assert.equal(questions.length, 1);
    assert.equal(pairs.length, 1);
    assert.equal(utterances[0]!.isWearer, true);
    assert.equal(utterances[1]!.isWearer, false);
    assert.ok(utterances[0]!.rmsDb > -11 && utterances[0]!.rmsDb < -10);
    assert.ok(utterances[1]!.rmsDb > -31 && utterances[1]!.rmsDb < -30);
    assert.equal(pairs[0]!.question.text, 'What time is lunch?');
    assert.equal(pairs[0]!.answer.text, 'Lunch is at noon.');
  } finally { await speech.close(); }
});

test('ElevenLabs aligns punctuation from the original text and preserves quotes and lowercase sentence starts', async () => {
  const { provider, socket, errors, utterances } = setup();
  try {
    socket.message({ message_type: 'session_started' });
    provider.sendAudio(new Uint8Array(64_000));
    socket.message({
      message_type: 'committed_transcript_with_timestamps',
      text: '  “When?!”\n  at noon.  ',
      words: [{ text: 'When', start: 0.1, end: 0.4 },
        { type: 'spacing', text: '\n  ' },
        { text: 'at', start: 0.6, end: 0.8 }, { text: 'noon', start: 0.9, end: 1.2 }],
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(utterances, [
      { text: '“When?!”', startMs: 100, endMs: 400, speaker: null },
      { text: 'at noon.', startMs: 600, endMs: 1_200, speaker: null },
    ]);
  } finally { await provider.close(); }
});

test('ElevenLabs does not split common honorifics or decimal points', async () => {
  const { provider, socket, errors, utterances } = setup();
  try {
    socket.message({ message_type: 'session_started' });
    provider.sendAudio(new Uint8Array(64_000));
    const texts = ['Dr.', 'Smith', 'arrives', 'at', '3.5.', 'Then', 'lunch.'];
    socket.message({ message_type: 'committed_transcript_with_timestamps',
      text: 'Dr. Smith arrives at 3.5. Then lunch.',
      words: texts.map((text, i) => ({ text, start: i * 0.2, end: (i + 1) * 0.2 })),
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(utterances.map((u) => u.text), ['Dr. Smith arrives at 3.5.', 'Then lunch.']);
  } finally { await provider.close(); }
});

test('ElevenLabs fails closed before emitting any sentence if alignment is incomplete or unsafe', async () => {
  for (const words of [
    combinedCommit.words.filter((word) => word.text !== 'time'),
    combinedCommit.words.map((word) => word.text === 'lunch?' ? { ...word, text: 'dinner?' } : word),
    [{ text: 'What time is lunch?  Lunch is at noon.', start: 0.1, end: 1.8 }],
  ]) {
    const { provider, socket, errors, utterances } = setup();
    socket.message({ message_type: 'session_started' });
    provider.sendAudio(new Uint8Array(64_000));
    socket.message({ ...combinedCommit, words });
    assert.deepEqual(utterances, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /align sentence/);
    await provider.close();
  }
});

test('ElevenLabs marks both precisely aligned sentences uncertain when their word times overlap', async () => {
  const { provider, socket, errors, utterances } = setup();
  socket.message({ message_type: 'session_started' });
  provider.sendAudio(new Uint8Array(64_000));
  socket.message({ ...combinedCommit,
    words: combinedCommit.words.map(word => word.text === 'lunch?' ? { ...word, end: 1.15 } : word),
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(utterances, [
    { text: 'What time is lunch?', startMs: 100, endMs: 1150, speaker: null, uncertain: true },
    { text: 'Lunch is at noon.', startMs: 1100, endMs: 1800, speaker: null, uncertain: true },
  ]);
  await provider.close();
});

for (const [name, words] of [
  ['missing', undefined], ['empty', []],
  ['negative', [{ start: -1, end: 0.5 }]],
  ['reversed', [{ start: 0.8, end: 0.1 }]],
  ['outside sent audio', [{ start: 0.1, end: 20 }]],
  ['string values', [{ start: '0.1', end: 0.5 }]],
  ['nonfinite', [{ start: null, end: 0.5 }]],
  ['unordered words', [{ start: 0.5, end: 0.6 }, { start: 0.1, end: 0.2 }]],
] as const) {
  test(`ElevenLabs rejects ${name} timestamps without fabricated utterances`, async () => {
    const { provider, socket, utterances, errors } = setup();
    socket.message({ message_type: 'session_started' });
    provider.sendAudio(new Uint8Array(32_000));
    socket.message({ ...transcript(), words });
    socket.message(transcript());
    assert.equal(errors.length, 1);
    assert.equal(socket.terminated, true);
    assert.deepEqual(utterances, []);
    await provider.close();
  });
}

test('ElevenLabs emits terminal errors once, redacts server text, and ignores late results', async () => {
  const { provider, socket, utterances, errors } = setup();
  socket.message({ message_type: 'auth_error', error: 'xi-api-key SECRET was rejected' });
  socket.emit('error', new Error('SECRET'));
  socket.message(transcript());
  provider.sendAudio(new Uint8Array(3_200));
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /auth_error/);
  assert.equal(errors[0]!.message.includes('SECRET'), false);
  assert.deepEqual(utterances, []);
  assert.deepEqual(socket.sent, []);
  await provider.close();
});

test('ElevenLabs bounds the pending queue and rejects odd PCM', async () => {
  for (const audio of [new Uint8Array(160_002), new Uint8Array(3)]) {
    const { provider, socket, errors } = setup();
    provider.sendAudio(audio);
    assert.equal(errors.length, 1);
    assert.equal(socket.terminated, true);
    assert.equal(socket.sent.length, 0);
    await provider.close();
  }
});

test('ElevenLabs treats backpressure and send failures as terminal', async () => {
  for (const reason of ['backpressure', 'payload-backpressure', 'send']) {
    const { provider, socket, errors } = setup();
    socket.message({ message_type: 'session_started' });
    if (reason === 'backpressure') socket.bufferedAmount = 256_001;
    else if (reason === 'payload-backpressure') socket.bufferedAmount = 255_999;
    else socket.sendError = true;
    provider.sendAudio(new Uint8Array(3_200));
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.message.includes('SECRET'), false);
    await provider.close();
  }
});

test('ElevenLabs retains a single overlapping-word sentence but flags its attribution uncertain', async () => {
  const { provider, socket, utterances, errors } = setup();
  socket.message({ message_type: 'session_started' });
  provider.sendAudio(new Uint8Array(32_000));
  socket.message({ message_type: 'committed_transcript_with_timestamps', text: 'Do not leave.', words: [
    { text: 'Do', start: 0.1, end: 0.7 },
    { text: 'not', start: 0.3, end: 0.4 },
    { text: 'leave.', start: 0.7, end: 0.9 },
  ] });
  assert.deepEqual(errors, []);
  assert.deepEqual(utterances, [{ text: 'Do not leave.', startMs: 100, endMs: 900, speaker: null, uncertain: true }]);
  await provider.close();
});

test('ElevenLabs still reports one safe error and settles close when transport termination throws', async () => {
  const failed = setup();
  failed.socket.terminate = () => { throw new Error('SECRET'); };
  assert.doesNotThrow(() => failed.socket.emit('error', new Error('SECRET')));
  assert.equal(failed.errors.length, 1);
  assert.equal(failed.errors[0]!.message.includes('SECRET'), false);
  failed.socket.close();
  await failed.provider.close();

  const closing = setup();
  closing.socket.close = () => {};
  closing.socket.terminate = () => { throw new Error('SECRET'); };
  await closing.provider.close();
  assert.deepEqual(closing.errors, []);
});

test('ElevenLabs closes idempotently, discards unfinished tail and suppresses callbacks', async () => {
  const { provider, socket, errors, utterances } = setup();
  socket.message({ message_type: 'session_started' });
  provider.sendAudio(new Uint8Array(320));
  const closing = provider.close();
  assert.equal(provider.close(), closing);
  await closing;
  socket.message(transcript());
  socket.emit('error', new Error('late error'));
  assert.deepEqual(socket.sent, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(utterances, []);
});

test('ElevenLabs session startup timeout terminates a socket even if transport opened', async () => {
  const { provider, socket, errors } = setup(10);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /startup timed out/);
  assert.equal(socket.terminated, true);
  await provider.close();
});

test('ElevenLabs rejects malformed JSON and unexpected remote closure once', async () => {
  for (const trigger of ['json', 'close']) {
    const { provider, socket, errors } = setup();
    if (trigger === 'json') socket.emit('message', Buffer.from('{SECRET'));
    else socket.close();
    socket.emit('error', new Error('SECRET'));
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.message.includes('SECRET'), false);
    await provider.close();
  }
});

test('ElevenLabs handles missing keys and transport constructor failures without leaking secrets', async () => {
  for (const apiKey of ['', 'SECRET']) {
    const errors: Error[] = [];
    let attempts = 0;
    const provider = createElevenLabsProvider({ apiKey, onError: (e) => errors.push(e), onUtterance() {} }, {
      createWebSocket() { attempts++; throw new Error('SECRET'); },
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.equal(attempts, apiKey ? 1 : 0);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.message.includes('SECRET'), false);
    await provider.close();
  }
});

test('ElevenLabs cancels a connecting socket and force closes an unresponsive socket', async () => {
  for (const connecting of [true, false]) {
    const { provider, socket, errors } = setup();
    socket.readyState = connecting ? WebSocket.CONNECTING : WebSocket.OPEN;
    if (!connecting) socket.close = () => {}; // No close handshake response.
    // Override terminate to model a transport that emits close only on abort.
    socket.terminate = () => {
      socket.terminated = true;
      socket.readyState = WebSocket.CLOSED;
      socket.emit('close');
    };
    await provider.close();
    assert.equal(socket.terminated, true);
    assert.deepEqual(errors, []);
  }
});

test('ElevenLabs works over a local real websocket with header auth and JSON PCM frames', async () => {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const errors: Error[] = [];
  const utterances: ProviderUtterance[] = [];
  let resolveResult: () => void;
  const result = new Promise<void>((resolve) => { resolveResult = resolve; });
  server.on('connection', (socket, request) => {
    assert.equal(request.headers['xi-api-key'], 'local-key');
    assert.equal(new URL(request.url!, 'http://localhost').searchParams.get('audio_format'), 'pcm_16000');
    socket.on('message', (raw) => {
      const chunk = JSON.parse(raw.toString());
      assert.equal(Buffer.from(chunk.audio_base_64, 'base64').length, 3_200);
      socket.send(JSON.stringify(transcript('Hello.', 0, 0.1)));
    });
    socket.send(JSON.stringify({ message_type: 'session_started' }));
  });
  const provider = createElevenLabsProvider({
    apiKey: 'local-key', onError: (error) => errors.push(error),
    onUtterance: (u) => { utterances.push(u); resolveResult(); },
  }, {
    createWebSocket: (url, options) => new WebSocket(`ws://127.0.0.1:${address.port}/${new URL(url).search}`, options),
  });
  const deadline = setTimeout(() => resolveResult(), 2_000);
  try {
    provider.sendAudio(new Uint8Array(3_200));
    await result;
    assert.deepEqual(errors, []);
    assert.deepEqual(utterances, [{ text: 'Hello.', startMs: 0, endMs: 100, speaker: null }]);
  } finally {
    clearTimeout(deadline);
    await provider.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
