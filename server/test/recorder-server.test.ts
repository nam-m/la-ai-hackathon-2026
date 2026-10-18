import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createRecorderServer, type RecorderServerOptions } from '../scripts/recorder-server.js';
import { readPcmWav } from '../src/speech/calibration.js';
import type { ConfigurableSpeechModule, SpeechOptions, Utterance } from '../src/speech/index.js';

const API_KEY = 'test-only-secret-recorder-key';
const TEMP_PREFIX = 'asked-answered-recorder-tests-';

function pcm(ms: number, amplitude: number): Buffer {
  const bytes = Buffer.alloc(ms * 32);
  for (let offset = 0; offset < bytes.length; offset += 2) bytes.writeInt16LE(amplitude, offset);
  return bytes;
}

function recordings(near = 6000, far = 500) {
  return {
    conversationPcm: Buffer.concat([pcm(500, near), pcm(500, far)]).toString('base64'),
  };
}

function inertSpeech(overrides: Partial<ConfigurableSpeechModule> = {}): ConfigurableSpeechModule {
  return {
    pushAudio() {}, pause() {}, resume() {}, close: async () => {},
    calibrateNextSpeaker() {}, markDisplayed() { return null; },
    ...overrides,
  };
}

async function start(t: TestContext, overrides: Partial<RecorderServerOptions> = {}) {
  const dataRoot = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  const calls: SpeechOptions[] = [];
  const { server, token } = createRecorderServer({
    apiKey: API_KEY, dataRoot, wait: async () => {},
    createSpeech: options => { calls.push(options); return inertSpeech(); },
    ...overrides,
  });
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    // Only remove the exact mkdtemp directory created for this test.
    assert.equal(dirname(resolve(dataRoot)), resolve(tmpdir()));
    assert.ok(basename(dataRoot).startsWith(TEMP_PREFIX));
    await rm(dataRoot, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-recorder-token': token, origin: base, ...headers },
    body: JSON.stringify(body),
  });
  return { server, token, base, dataRoot, calls, post };
}

async function events(response: Response): Promise<Record<string, unknown>[]> {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/x-ndjson/);
  const text = await response.text();
  assert.equal(text.includes(API_KEY), false);
  return text.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
}

test('recorder status reports provider/key availability without exposing credentials', async t => {
  const h = await start(t);
  const response = await fetch(`${h.base}/api/status`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { keyConfigured: true, provider: 'elevenlabs' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(h.calls.length, 0);
});

test('recorder requires the local origin and session token before processing audio', async t => {
  const h = await start(t);
  const invalidHeaders: Record<string, string>[] = [
    { 'x-recorder-token': 'incorrect' },
    { 'x-recorder-token': '' },
    { origin: 'https://untrusted.example' },
    { origin: 'null' },
  ];
  for (const headers of invalidHeaders) {
    const response = await h.post(recordings(), headers);
    assert.equal(response.status, 403);
    assert.match((await response.json() as { error: string }).error, /Reload/);
  }
  assert.equal(h.calls.length, 0);
  assert.deepEqual(await readdir(h.dataRoot), []);
});

test('recorder rejects invalid audio before creating a transcription module', async t => {
  const h = await start(t);
  const valid = recordings();
  const invalid = [
    null,
    [],
    {},
    { conversationPcm: 'not-base64' },
    { conversationPcm: 'AA==' },
    { ...valid, conversationPcm: pcm(999, 500).toString('base64') },
  ];
  for (const body of invalid) {
    const response = await h.post(body);
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.match(text, /error/);
    assert.equal(text.includes(API_KEY), false);
  }
  assert.equal(h.calls.length, 0);
  assert.deepEqual(await readdir(h.dataRoot), []);
});

test('recorder enforces JSON and a configured server key', async t => {
  const h = await start(t, { apiKey: '' });
  const nonJson = await h.post(recordings(), { 'content-type': 'text/plain' });
  assert.equal(nonJson.status, 415);
  await nonJson.text();
  const missingKey = await h.post(recordings());
  assert.equal(missingKey.status, 503);
  const body = await missingKey.json() as { error: string };
  assert.match(body.error, /ELEVENLABS_API_KEY/);
  assert.equal(h.calls.length, 0);
});

test('equal voice levels are transcribed without calibration or a wearer threshold', async t => {
  const h = await start(t);
  const output = await events(await h.post(recordings(6000, 6000)));
  assert.equal(output.some(value => value.event === 'calibration'), false);
  assert.equal(output.some(value => value.event === 'error'), false);
  assert.equal(output.at(-1)?.event, 'done');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.wearerThresholdDb, undefined);
});

test('one recording streams results without guessed identity and saves exact WAV audio', async t => {
  const inputs: Uint8Array[] = [];
  let speechOptions: SpeechOptions | undefined;
  let closed = 0;
  const question: Utterance = {
    id: 'q-1', text: 'What time is lunch?', startMs: 0, endMs: 500,
    rmsDb: -15, speaker: null, name: null, role: 'wearer', isWearer: true,
  };
  const answer: Utterance = {
    id: 'a-1', text: 'Lunch is at noon.', startMs: 500, endMs: 1000,
    rmsDb: -36, speaker: null, name: null, role: 'other', isWearer: false,
  };
  const h = await start(t, { createSpeech: options => {
    speechOptions = options;
    let emitted = false;
    return inertSpeech({
      pushAudio(frame) {
        inputs.push(Uint8Array.from(frame));
        if (emitted) return;
        emitted = true;
        options.onUtterance(question);
        options.onWearerQuestion(question);
        options.onLatency?.({ questionId: question.id, transcriptMs: 200 });
        options.onUtterance(answer);
        options.onPair({ question, answer });
      },
      async close() { closed++; },
    });
  } });
  const body = recordings();
  const output = await events(await h.post(body));
  assert.equal(speechOptions?.provider, 'elevenlabs');
  assert.equal(speechOptions?.apiKey, API_KEY);
  assert.equal(speechOptions?.wearerThresholdDb, undefined);
  assert.equal(output.some(value => value.event === 'calibration'), false);
  assert.equal(output.filter(value => value.event === 'utterance').length, 2);
  assert.equal(output.filter(value => value.event === 'utterance').every(value => value.identityKnown === false), true);
  assert.equal(output.filter(value => value.event === 'question').length, 1);
  assert.equal(output.filter(value => value.event === 'pair').length, 1);
  assert.equal(output.filter(value => value.event === 'latency').length, 1);
  const done = output.at(-1)!;
  assert.equal(done.event, 'done');
  assert.equal(done.utterances, 2);
  assert.equal(done.questions, 1);
  assert.equal(done.pairs, 1);
  assert.equal(output.some(value => value.event === 'error'), false);
  assert.ok(closed >= 1);
  const sent = Buffer.concat(inputs);
  assert.deepEqual(sent.subarray(0, 32_000), Buffer.from(body.conversationPcm, 'base64'));
  assert.equal(sent.subarray(32_000).every(value => value === 0), true);

  const runs = await readdir(h.dataRoot);
  assert.equal(runs.length, 1);
  const outputDir = join(h.dataRoot, runs[0]!);
  assert.deepEqual((await readdir(outputDir)).sort(), ['conversation.wav', 'results.json']);
  for (const [filename, encoded] of [
    ['conversation.wav', body.conversationPcm],
  ]) {
    const saved = readPcmWav(await readFile(join(outputDir, filename!)));
    assert.deepEqual(Buffer.from(saved), Buffer.from(encoded!, 'base64'));
  }
  const saved = JSON.parse(await readFile(join(outputDir, 'results.json'), 'utf8')) as {
    utterances: number; questions: number; pairs: number; events: Record<string, unknown>[];
  };
  assert.deepEqual({ utterances: saved.utterances, questions: saved.questions, pairs: saved.pairs }, { utterances: 2, questions: 1, pairs: 1 });
  assert.deepEqual(saved.events.find(value => value.event === 'pair'), { event: 'pair', question, answer });
  assert.equal(JSON.stringify(saved).includes(API_KEY), false);
});

test('provider failure sends a redacted error and no success event', async t => {
  let invocations = 0;
  const h = await start(t, { createSpeech: options => {
    invocations++;
    let failed = false;
    return inertSpeech({ pushAudio() {
      if (failed) return;
      failed = true;
      options.onError(new Error(`Provider rejected credential ${API_KEY}; repeated ${API_KEY}`));
    } });
  } });
  const output = await events(await h.post(recordings()));
  assert.equal(invocations, 1);
  assert.equal(output.filter(value => value.event === 'error').length, 1);
  const failure = output.find(value => value.event === 'error')!;
  assert.equal(failure.message, 'Provider rejected credential [redacted]; repeated [redacted]');
  assert.equal(output.some(value => value.event === 'done'), false);
});

test('a rejected provider close cannot hang a response or leave the recorder busy', async t => {
  let invocations = 0;
  const h = await start(t, { createSpeech: () => {
    invocations++;
    return inertSpeech({ close: async () => { throw new Error(`close failed ${API_KEY}`); } });
  } });
  assert.equal((await events(await h.post(recordings()))).at(-1)?.event, 'done');
  assert.equal((await events(await h.post(recordings()))).at(-1)?.event, 'done');
  assert.equal(invocations, 2);
});

test('recorder serializes tests and releases its busy state after a completed request', async t => {
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const reachedWait = new Promise<void>(resolveWait => { started = resolveWait; });
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  let waiting = false;
  const h = await start(t, { wait: async () => {
    if (waiting) return;
    waiting = true;
    started!();
    await gate;
  } });
  t.after(() => release?.());
  const first = h.post(recordings());
  await reachedWait;
  const concurrent = await h.post(recordings());
  assert.equal(concurrent.status, 409);
  assert.match((await concurrent.json() as { error: string }).error, /already being tested/);
  release!();
  assert.equal((await events(await first)).at(-1)?.event, 'done');
  assert.equal((await events(await h.post(recordings()))).at(-1)?.event, 'done');
  assert.equal(h.calls.length, 2);
});
