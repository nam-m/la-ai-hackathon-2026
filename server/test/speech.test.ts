import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechModule, isQuestion, type SpeechOptions, type Utterance, type QAPair } from '../src/speech/index.js';
import type { ProviderOptions } from '../src/speech/types.js';
import { SpeechLatencyTracker } from '../src/speech/latency.js';
import { speechOptionsFromEnv } from '../src/speech/config.js';

function pcm(ms: number, amplitude: number): Uint8Array {
  const bytes = Buffer.alloc(ms * 32);
  for (let i = 0; i < bytes.length; i += 2) bytes.writeInt16LE(amplitude, i);
  return bytes;
}

function harness(overrides: Partial<SpeechOptions> = {}) {
  const connections: ProviderOptions[] = [];
  const sent: Uint8Array[] = [];
  const utterances: Utterance[] = [];
  const questions: Utterance[] = [];
  const pairs: QAPair[] = [];
  const errors: Error[] = [];
  let clock = 100_000;
  let closes = 0;
  const speech = createSpeechModule({ provider: 'elevenlabs', apiKey: 'local-test', wearerThresholdDb: -25,
    onUtterance: u => utterances.push(u), onWearerQuestion: q => questions.push(q), onPair: p => pairs.push(p), onError: e => errors.push(e),
    now: () => clock,
    providerFactory: options => { connections.push(options); return { sendAudio: data => sent.push(data), close: async () => { closes++; } }; },
    ...overrides });
  return { speech, connections, sent, utterances, questions, pairs, errors,
    get closes() { return closes; },
    advance(ms: number) { clock += ms; },
    push(ms: number, amp = 6000) { clock += ms; speech.pushAudio(pcm(ms, amp)); },
    say(text: string, startMs: number, endMs: number, speaker: string | null = null) {
      connections.at(-1)!.onUtterance({ text, startMs, endMs, speaker });
    } };
}

test('questions use punctuation and bounded question prefixes', () => {
  for (const text of ['What time is lunch', 'When’s lunch?', 'Is Sarah here', 'Lunch is when?', '“Where is Mary?”']) assert.equal(isQuestion(text), true, text);
  for (const text of ['Lunch is at noon.', 'Whatever works.', 'Sarah is here.', '']) assert.equal(isQuestion(text), false, text);
});

test('loud wearer question fires immediately; quiet answer captured verbatim once', async () => {
  const h = harness();
  try {
    h.push(500); h.say('What time is lunch?', 0, 500);
    assert.equal(h.questions.length, 1); assert.equal(h.pairs.length, 0);
    h.push(500, 500); h.say('Lunch is at noon.', 500, 1000);
    h.say('Lunch is at noon.', 500, 1000);
    assert.equal(h.pairs.length, 1);
    assert.equal(h.pairs[0]!.answer.text, 'Lunch is at noon.');
    assert.equal(h.pairs[0]!.answer.name, null);
    assert.equal(h.utterances.length, 2);
  } finally { await h.speech.close(); }
});

test('wearer answers and questions from others cannot create pairs', async () => {
  const h = harness();
  try {
    h.push(500, 500); h.say('What time is lunch?', 0, 500);
    h.push(500); h.say('Lunch is at noon.', 500, 1000);
    assert.equal(h.questions.length, 0); assert.equal(h.pairs.length, 0);
    h.push(500); h.say('Where is Mary?', 1000, 1500);
    h.push(500); h.say('At the store.', 1500, 2000);
    assert.equal(h.pairs.length, 0);
    h.push(500, 500); h.say('At the store.', 2000, 2500);
    assert.equal(h.pairs.length, 1);
  } finally { await h.speech.close(); }
});

test('unknown identity is visible as a transcript but never an answer or question', async () => {
  const h = harness({ wearerThresholdDb: undefined });
  try {
    h.push(500); h.say('When is lunch?', 0, 500);
    h.push(500, 500); h.say('Noon.', 500, 1000);
    assert.equal(h.utterances.length, 2); assert.equal(h.questions.length, 0); assert.equal(h.pairs.length, 0);
  } finally { await h.speech.close(); }
});

test('other-speaker clarification question cancels pending answer capture', async () => {
  const h = harness();
  try {
    h.push(500); h.say('When is lunch?', 0, 500);
    h.push(500, 500); h.say('Do you mean dinner?', 500, 1000);
    h.push(500, 500); h.say('At six.', 1000, 1500);
    assert.equal(h.pairs.length, 0);
  } finally { await h.speech.close(); }
});

test('latest wearer question replaces prior question', async () => {
  const h = harness();
  try {
    h.push(500); h.say('When is lunch?', 0, 500);
    h.push(500); h.say('Where is Mary?', 500, 1000);
    h.push(500, 500); h.say('At the store.', 1000, 1500);
    assert.equal(h.pairs[0]!.question.text, 'Where is Mary?');
  } finally { await h.speech.close(); }
});

test('30 second timeout includes silence skipped before transcription', async () => {
  const h = harness();
  try {
    h.push(500); h.say('When is lunch?', 0, 500);
    // Individual websocket frames are capped at ten seconds.
    for (let i = 0; i < 4; i++) h.push(8000, 0);
    h.push(500, 500);
    const providerEnd = h.sent.reduce((total, frame) => total + frame.length / 32, 0);
    h.say('At noon.', providerEnd - 500, providerEnd);
    assert.equal(h.utterances.at(-1)!.startMs, 32500);
    assert.equal(h.pairs.length, 0);
  } finally { await h.speech.close(); }
});

test('late provider results cannot bypass wall-clock timeout', async () => {
  const h = harness();
  try {
    h.push(500); h.say('When is lunch?', 0, 500);
    h.push(500, 500); h.advance(31_000); h.say('At noon.', 500, 1000);
    assert.equal(h.pairs.length, 0);
  } finally { await h.speech.close(); }
});

test('overlapping speech cannot be saved as an answer', async () => {
  const h = harness({ provider: 'deepgram', wearerSpeaker: '0' });
  try {
    h.push(1000); h.say('When is lunch?', 0, 700, '0'); h.say('At noon.', 600, 1000, '1');
    assert.equal(h.pairs.length, 0);
  } finally { await h.speech.close(); }
});

test('Deepgram setup labels wearer and family without storing setup speech', async () => {
  const h = harness({ provider: 'deepgram', wearerThresholdDb: undefined });
  try {
    h.speech.calibrateNextSpeaker({ isWearer: true });
    h.push(500); h.say('My name is Rose.', 0, 500, '2');
    h.speech.calibrateNextSpeaker({ isWearer: false, name: 'Sarah' });
    h.push(500); h.say('I am Sarah.', 500, 1000, '3');
    h.push(500, 500); h.say('When is lunch?', 1000, 1500, '2');
    h.push(500); h.say('At noon.', 1500, 2000, '3');
    assert.equal(h.utterances.length, 2);
    assert.equal(h.pairs[0]!.answer.name, 'Sarah');
  } finally { await h.speech.close(); }
});

test('pause clears pending pairs and suppresses late old-connection results', async () => {
  const h = harness();
  try {
    h.push(500); h.say('When is lunch?', 0, 500);
    const old = h.connections[0]!;
    h.speech.pause(); h.push(500); h.speech.resume(); h.push(500, 500);
    old.onUtterance({ text: 'Old answer.', startMs: 0, endMs: 500, speaker: null });
    h.say('At noon.', 0, 500);
    assert.equal(h.pairs.length, 0); assert.equal(h.utterances.length, 2);
    assert.equal(h.utterances[1]!.startMs, 1000);
    await h.speech.close(); await h.speech.close();
    assert.equal(h.closes, 2);
  } finally { await h.speech.close(); }
});

test('provider failure invalidates pending setup before resume', async () => {
  const h = harness({ provider: 'deepgram', wearerThresholdDb: undefined });
  try {
    h.speech.calibrateNextSpeaker({ isWearer: true });
    h.connections[0]!.onError(new Error('disconnected'));
    h.speech.resume(); h.push(500); h.say('When is lunch?', 0, 500, '4');
    assert.equal(h.errors.length, 1); assert.equal(h.utterances.length, 1); assert.equal(h.questions.length, 0);
  } finally { await h.speech.close(); }
});

test('callback pause/resume cannot let old-generation question enter new session', async () => {
  const h = harness({ onUtterance() { h.speech.pause(); h.speech.resume(); } });
  try { h.push(500); h.say('When is lunch?', 0, 500); assert.equal(h.questions.length, 0); }
  finally { await h.speech.close(); }
});

test('invalid provider time ranges never invent utterances', async () => {
  const h = harness();
  try {
    h.push(500);
    for (const [start, end] of [[0, 600], [NaN, 500], [-1, 500], [500, 0]]) h.say('When is lunch?', start!, end!);
    assert.equal(h.utterances.length, 0);
  } finally { await h.speech.close(); }
});

test('ElevenLabs connects only on speech and rotates idle socket without losing timestamps', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  try {
    assert.equal(h.connections.length, 0);
    h.push(500); h.say('When is lunch?', 0, 500);
    const old = h.connections[0]!;
    h.push(3000, 0);
    t.mock.timers.tick(8000);
    assert.equal(h.closes, 1);
    h.push(500, 500);
    assert.equal(h.connections.length, 2);
    old.onUtterance({ text: 'Stale.', startMs: 0, endMs: 500, speaker: null });
    // Fresh connection starts with 100ms of preserved preroll.
    h.say('At noon.', 100, 600);
    assert.equal(h.pairs.length, 1);
    assert.equal(h.pairs[0]!.answer.startMs, 3500);
  } finally { await h.speech.close(); }
});

test('fake script pauses and resumes without emitting during pause', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const seen: string[] = [];
  const speech = createSpeechModule({ provider: 'fake', apiKey: '',
    fakeScript: [{ text: 'When is lunch?', startMs: 0, endMs: 500, isWearer: true, name: null }, { text: 'At noon.', startMs: 500, endMs: 1000, isWearer: false, name: 'Sarah' }],
    onUtterance: u => seen.push(u.text), onWearerQuestion() {}, onPair() {}, onError: e => { throw e; } });
  try {
    t.mock.timers.tick(500); assert.equal(seen.length, 1);
    speech.pause(); t.mock.timers.tick(5000); assert.equal(seen.length, 1);
    speech.resume(); t.mock.timers.tick(500); assert.equal(seen.length, 2);
    await speech.close(); t.mock.timers.tick(5000); assert.equal(seen.length, 2);
  } finally { await speech.close(); }
});

test('latency needs real display acknowledgement and consumes it once', () => {
  const tracker = new SpeechLatencyTracker();
  assert.deepEqual(tracker.markFinal('q1', 1000, 1600), { questionId: 'q1', transcriptMs: 600 });
  assert.deepEqual(tracker.markDisplayed('q1', 3100), { questionId: 'q1', transcriptMs: 600, totalMs: 2100, withinTarget: false });
  assert.equal(tracker.markDisplayed('q1', 3200), null);
});

test('server env defaults to ElevenLabs, validates numeric settings and does not assume wearer', () => {
  assert.equal(speechOptionsFromEnv({}).provider, 'elevenlabs');
  assert.equal(speechOptionsFromEnv({}).wearerThresholdDb, undefined);
  assert.equal(speechOptionsFromEnv({ SPEECH_WEARER_THRESHOLD_DB: '-27' }).wearerThresholdDb, -27);
  assert.throws(() => speechOptionsFromEnv({ SPEECH_WEARER_THRESHOLD_DB: 'nan' }));
  assert.throws(() => speechOptionsFromEnv({ SPEECH_SPEAKER_NAMES: '[]' }));
});
