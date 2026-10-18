import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test, { after, type TestContext } from 'node:test';
import type { WebSocket } from 'ws';
import type { SessionDependencies } from '../src/session.js';
import type { SpeechOptions, Utterance } from '../src/speech/index.js';
import type { QARecord, ServerMessage } from '../src/types.js';
import { createSpeechModule } from '../src/speech/index.js';
import type { ProviderOptions } from '../src/speech/types.js';

// Dynamic imports keep the real store and dotenv isolated from developer data/keys.
const directory = await mkdtemp(join(tmpdir(), 'role-b-session-tests-'));
process.env.DOTENV_CONFIG_PATH = join(directory, 'no-env-file');
process.env.DATA_FILE = join(directory, 'store.json');
process.env.SPEECH_PROVIDER = 'fake';
process.env.SPEECH_API_KEY = 'test-only';
process.env.SPEECH_WEARER_THRESHOLD_DB = '-25';
process.env.SPEECH_WEARER_MARGIN_DB = '3';
process.env.GEMINI_API_KEY = '';
process.env.TONE_URL = '';
const { Session } = await import('../src/session.js');
const store = await import('../src/store.js');
after(async () => {
  store.flush();
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('role-b-session-tests-'));
  await rm(directory, { recursive: true, force: true });
});

class Phone extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: ServerMessage[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  json(message: object) { this.emit('message', Buffer.from(JSON.stringify(message)), false); }
  audio(bytes: Buffer) { this.emit('message', bytes, true); }
  terminate() { this.readyState = 3; this.emit('close'); }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const settle = () => new Promise<void>(done => setImmediate(done));
const noMatch: SessionDependencies['findMatch'] = async question => ({ match: null, log: { question, decision: 'none', ms: 0 } });
function harness(t: TestContext, overrides: Partial<SessionDependencies> = {}) {
  let options!: SpeechOptions;
  const phone = new Phone();
  const deps: SessionDependencies = {
    createSpeech: value => { options = value; return { pushAudio() {}, pause() {}, resume() {}, close: async () => {} }; },
    findMatch: noMatch, isReply: async () => true, warm: async () => {}, analyzeQuestion: async () => null,
    ...overrides,
  };
  const session = new Session(phone as unknown as WebSocket, deps);
  t.after(() => phone.terminate());
  phone.json({ v: 1, type: 'hello', session: t.name, source: 'glasses' });
  return { phone, session, get speech() { return options; } };
}
function utterance(id: string, role: Utterance['role'], startMs: number, text = id): Utterance {
  return { id, role, isWearer: role === 'wearer', text, startMs, endMs: startMs + 500,
    rmsDb: role === 'wearer' ? -18 : -36, speaker: null, name: null };
}

test('server passes calibrated attribution configuration into B', t => {
  const h = harness(t);
  assert.equal(h.speech.wearerThresholdDb, -25);
  assert.equal(h.speech.wearerMarginDb, 3);
});

test('candidate verification is ordered: unrelated line rejected, earliest reply saved once', async t => {
  const first = deferred<boolean>();
  const checked: string[] = [];
  const h = harness(t, { isReply: async (_q, a) => { checked.push(a); return checked.length === 1 ? first.promise : true; } });
  const q = utterance('ordered-question', 'wearer', 0);
  h.speech.onWearerQuestion(q);
  for (const [i, text] of ['Unrelated.', 'Lunch is at noon.', 'Lunch is at one.'].entries()) {
    h.speech.onPair({ question: q, answer: utterance(text, 'other', 500 + i * 500) });
  }
  await settle();
  assert.deepEqual(checked, ['Unrelated.']);
  first.resolve(false);
  await settle();
  assert.deepEqual(checked, ['Unrelated.', 'Lunch is at noon.']);
  const records = store.todaysSpokenPairs().filter(r => r.question === q.text);
  assert.equal(records.length, 1);
  assert.equal(records[0].answer, 'Lunch is at noon.');
  assert.equal(store.todaysEvents().find(e => e.question === q.text)?.answerRecordId, records[0].id);
});

for (const action of ['new question', 'pause and resume', 'close'] as const) {
  test(`pending reply cannot save after ${action}`, async t => {
    const verification = deferred<boolean>();
    let checks = 0;
    const h = harness(t, { isReply: async () => { checks++; return verification.promise; } });
    const q = utterance(`stale-${action}`, 'wearer', 0);
    h.speech.onWearerQuestion(q);
    h.speech.onPair({ question: q, answer: utterance('old answer', 'other', 500) });
    h.speech.onPair({ question: q, answer: utterance('queued answer', 'other', 1000) });
    await settle();
    if (action === 'new question') h.speech.onWearerQuestion(utterance(`new-${action}`, 'wearer', 2000));
    else if (action === 'close') h.phone.terminate();
    else {
      h.phone.json({ v: 1, type: 'control', action: 'pause' });
      h.phone.json({ v: 1, type: 'control', action: 'resume' });
    }
    verification.resolve(true);
    await settle();
    assert.equal(checks, 1);
    assert.equal(store.todaysSpokenPairs().some(r => r.question === q.text), false);
  });
}

for (const action of ['new question', 'pause and resume', 'close'] as const) {
  test(`pending match cannot display after ${action}`, async t => {
    const match = deferred<Awaited<ReturnType<SessionDependencies['findMatch']>>>();
    let matchCalls = 0;
    const h = harness(t, { findMatch: question => ++matchCalls === 1 ? match.promise : noMatch(question) });
    const q = utterance(`match-${action}`, 'wearer', 0);
    const record: QARecord = { id: q.id, question: q.text, answer: 'An old answer', askedAt: new Date().toISOString(),
      answeredAt: new Date().toISOString(), answeredBy: null, source: 'family', standing: true };
    store.upsert(record);
    h.speech.onWearerQuestion(q);
    if (action === 'new question') h.speech.onWearerQuestion(utterance(`replacement-${action}`, 'wearer', 2000));
    else if (action === 'close') h.phone.terminate();
    else {
      h.phone.json({ v: 1, type: 'control', action: 'pause' });
      h.phone.json({ v: 1, type: 'control', action: 'resume' });
    }
    match.resolve({ match: { record, score: 1 }, log: { question: q.text, decision: 'match', ms: 1 } });
    await settle();
    assert.equal(h.phone.sent.some(m => m.type === 'answer'), false);
    assert.equal(store.todaysEvents().find(e => e.question === q.text)?.matchedRecordId, null);
  });
}

test('real B byte clock cuts exact tone audio after skipped silence and pause; tone never blocks matching', async t => {
  let provider!: ProviderOptions;
  let clock = 0;
  const clips: Uint8Array[] = [];
  let matches = 0;
  const tone = deferred<null>();
  const h = harness(t, {
    createSpeech: options => createSpeechModule({ ...options, provider: 'elevenlabs', apiKey: 'test-only', now: () => clock,
      providerFactory: callbacks => { provider = callbacks; return { sendAudio() {}, close: async () => {} }; } }),
    findMatch: async q => { matches++; return noMatch(q); },
    analyzeQuestion: async (_id, bytes) => { assert.ok(bytes); clips.push(bytes); return tone.promise; },
  });
  const pcm = (ms: number, amplitude: number) => {
    const bytes = Buffer.alloc(ms * 32);
    for (let i = 0; i < bytes.length; i += 2) bytes.writeInt16LE(amplitude, i);
    return bytes;
  };
  clock = 20_000; // no PCM yet; wall delay must not affect source times
  h.phone.audio(pcm(500, 0));
  const first = pcm(500, 6000);
  h.phone.audio(first);
  // VAD forwarded 100ms preroll then the 500ms question.
  provider.onUtterance({ text: 'Where is lunch?', startMs: 100, endMs: 600, speaker: null });
  await settle();
  assert.deepEqual(Buffer.from(clips[0]), first);
  h.phone.json({ v: 1, type: 'control', action: 'pause' });
  clock += 30_000;
  h.phone.audio(pcm(500, 100)); // deliberately ignored while paused
  h.phone.json({ v: 1, type: 'control', action: 'resume' });
  const second = pcm(500, 7000);
  h.phone.audio(second);
  provider.onUtterance({ text: 'When is lunch?', startMs: 0, endMs: 500, speaker: null });
  await settle();
  assert.deepEqual(Buffer.from(clips[1]), second);
  assert.equal(matches, 2);
  tone.resolve(null);
});

test('missing speech credentials report an error instead of crashing the phone session', t => {
  const h = harness(t, { createSpeech: () => { throw new Error('test-secret must never be logged'); } });
  assert.ok(h.phone.sent.some(m => m.type === 'error' && m.code === 'stt_down'));
  assert.equal(JSON.stringify(h.phone.sent).includes('test-secret'), false);
  assert.equal(h.phone.sent.some(m => m.type === 'status' && m.text === 'Listening'), false);
});

test('resume retries failed speech construction', t => {
  let attempts = 0;
  const h = harness(t, { createSpeech: () => {
    if (++attempts === 1) throw new Error('not ready');
    return { pushAudio() {}, pause() {}, resume() {}, close: async () => {} };
  } });
  h.phone.json({ v: 1, type: 'control', action: 'resume' });
  assert.equal(attempts, 2);
  assert.ok(h.phone.sent.some(m => m.type === 'status' && m.text === 'Listening'));
});

test('pause before hello does not open a speech connection until deliberate resume', t => {
  const phone = new Phone();
  let created = 0;
  new Session(phone as unknown as WebSocket, {
    createSpeech: () => { created++; return { pushAudio() {}, pause() {}, resume() {}, close: async () => {} }; },
    findMatch: noMatch, isReply: async () => false, warm: async () => {}, analyzeQuestion: async () => null,
  });
  t.after(() => phone.terminate());
  phone.json({ v: 1, type: 'control', action: 'pause' });
  phone.json({ v: 1, type: 'hello', session: 'prepaused', source: 'glasses' });
  assert.equal(created, 0);
  assert.equal(phone.sent.some(m => m.type === 'status' && m.text === 'Listening'), false);
  phone.json({ v: 1, type: 'control', action: 'resume' });
  assert.equal(created, 1);
});
