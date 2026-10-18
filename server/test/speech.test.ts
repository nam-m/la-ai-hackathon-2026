import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechModule, isQuestion, type SpeechOptions, type Utterance, type QAPair } from '../src/speech/index.js';
import type { ProviderOptions } from '../src/speech/types.js';
import { SpeechLatencyTracker } from '../src/speech/latency.js';
import { speechOptionsFromEnv } from '../src/speech/config.js';
import { readFakeScript } from '../src/speech/fake.js';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  for (const text of ['What time is lunch', 'When’s lunch?', 'Is Sarah here', 'Lunch is when?', '“Where is Mary?”', 'Who\'s that', 'Can you help?', 'Where is Mary...', 'Where is Mary…', 'What time is lunch？', 'Lunch is when？']) assert.equal(isQuestion(text), true, text);
  for (const text of ['Lunch is at noon．', 'What a lovely day！', 'Do it now。']) assert.equal(isQuestion(text), false, text);
  for (const text of ['Lunch is at noon.', 'Whatever works.', 'Sarah is here.', '', 'Can\'t find my keys.', 'Can’t find my keys', 'What a lovely day!', 'Do it now.', 'Have a good one.']) assert.equal(isQuestion(text), false, text);
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
    assert.deepEqual(h.utterances.map(u => u.role), ['wearer', 'other']);
    for (const u of h.utterances) assert.equal(u.isWearer, u.role === 'wearer');
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

test('every other-role line including clarification questions is a candidate in spoken order', async () => {
  const h = harness();
  try {
    h.push(500); h.say('When is lunch?', 0, 500);
    h.push(500, 500); h.say('Do you mean dinner?', 500, 1000);
    h.push(500, 500); h.say('At six.', 1000, 1500);
    h.say('At six.', 1000, 1500);
    assert.deepEqual(h.pairs.map(pair => pair.answer.text), ['Do you mean dinner?', 'At six.']);
    assert.ok(h.pairs.every(pair => pair.question.text === 'When is lunch?' && pair.answer.role === 'other'));
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

test('the candidate window uses spoken PCM time even when final transcripts arrive late', async () => {
  const h = harness();
  try {
    h.push(500); h.say('When is lunch?', 0, 500);
    h.push(500, 500); h.advance(31_000); h.say('At noon.', 500, 1000);
    assert.equal(h.pairs.length, 1);
    assert.equal(h.pairs[0]!.answer.startMs, 500);
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

// Fail the provider until the reconnect budget (3 per minute) is spent, so transcription is reported down.
function exhaustReconnects(h: ReturnType<typeof harness>, error = new Error('disconnected')) {
  for (let attempt = 0; attempt < 3; attempt++) { h.connections.at(-1)!.onError(error); h.push(100); }
  h.connections.at(-1)!.onError(error);
}

test('a dropped provider connection reconnects on the next audio and keeps the source clock', async () => {
  const h = harness();
  try {
    h.push(500); h.say('When is lunch?', 0, 500);
    h.connections[0]!.onError(new Error('lost connection'));
    assert.equal(h.errors.length, 0);
    h.push(500); h.say('At noon.', 0, 500);
    assert.equal(h.connections.length, 2);
    assert.equal(h.errors.length, 0);
    assert.equal(h.utterances[1]!.startMs, 500);
    assert.equal(h.utterances[1]!.endMs, 1000);
  } finally { await h.speech.close(); }
});

test('a Deepgram auto-reconnect forgets connection-local speaker labels', async () => {
  const h = harness({ provider: 'deepgram', wearerThresholdDb: undefined, wearerSpeaker: '0' });
  try {
    h.push(500); h.say('When is lunch?', 0, 500, '0');
    assert.equal(h.utterances[0]!.role, 'wearer');
    h.connections.at(-1)!.onError(new Error('lost connection'));
    h.push(500); h.say('Who is that?', 0, 500, '0');
    assert.equal(h.connections.length, 2);
    // Label '0' on the new connection may be anyone: it must not inherit "wearer".
    assert.equal(h.utterances[1]!.role, 'unknown');
  } finally { await h.speech.close(); }
});

test('auth, quota and missing-key errors fail at once without reconnecting', async () => {
  for (const message of ['ElevenLabs transcription failed (auth_error)', 'ElevenLabs transcription failed (quota_exceeded)',
    'ElevenLabs transcription requires an API key', 'Deepgram WebSocket handshake was rejected']) {
    const h = harness();
    try {
      h.push(500);
      h.connections.at(-1)!.onError(new Error(message));
      h.push(500);
      assert.equal(h.errors.length, 1, message);
      assert.equal(h.connections.length, 1, message);
    } finally { await h.speech.close(); }
  }
});

test('resume starts with a fresh reconnect budget', async () => {
  const h = harness();
  try {
    h.push(500);
    exhaustReconnects(h);
    assert.equal(h.errors.length, 1);
    h.speech.resume(); h.push(100);
    h.connections.at(-1)!.onError(new Error('lost connection'));
    assert.equal(h.errors.length, 1); // a first drop after resume reconnects instead of failing again
  } finally { await h.speech.close(); }
});

test('transcription is reported down only after 3 reconnects within a minute', async () => {
  const h = harness();
  try {
    h.push(500);
    exhaustReconnects(h);
    assert.equal(h.connections.length, 4);
    assert.equal(h.errors.length, 1);
  } finally { await h.speech.close(); }
});

test('provider failure invalidates pending setup before resume', async () => {
  const h = harness({ provider: 'deepgram', wearerThresholdDb: undefined });
  try {
    h.speech.calibrateNextSpeaker({ isWearer: true });
    exhaustReconnects(h);
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
  const seen: Utterance[] = [];
  const speech = createSpeechModule({ provider: 'fake', apiKey: '',
    fakeScript: [{ text: 'When is lunch?', startMs: 0, endMs: 500, isWearer: true, name: null }, { text: 'At noon.', startMs: 500, endMs: 1000, isWearer: false, name: 'Sarah' }],
    onUtterance: u => seen.push(u), onWearerQuestion() {}, onPair() {}, onError: e => { throw e; } });
  try {
    t.mock.timers.tick(500); assert.equal(seen.length, 1);
    speech.pause(); t.mock.timers.tick(5000); assert.equal(seen.length, 1);
    speech.resume(); t.mock.timers.tick(500); assert.equal(seen.length, 2);
    assert.deepEqual(seen.map(u => [u.startMs, u.endMs, u.role, u.isWearer]), [[0, 500, 'wearer', true], [500, 1000, 'other', false]]);
    await speech.close(); t.mock.timers.tick(5000); assert.equal(seen.length, 2);
  } finally { await speech.close(); }
});

test('calibrated margin and very quiet audio abstain while preserving the latest question window', async () => {
  const h = harness();
  try {
    h.push(500); h.say('When is lunch?', 0, 500);
    h.push(500, 1800); h.say('Where is Mary?', 500, 1000); // About -25.2 dBFS: inside margin.
    h.push(500, 10); h.say('Very quiet.', 1000, 1500);
    h.push(500, 500); h.say('At noon.', 1500, 2000);
    assert.deepEqual(h.utterances.map(u => u.role), ['wearer', 'unknown', 'unknown', 'other']);
    assert.equal(h.questions.length, 1);
    assert.equal(h.pairs.length, 1);
    assert.equal(h.pairs[0]!.question.text, 'When is lunch?');
    assert.ok(h.utterances.every(u => u.isWearer === (u.role === 'wearer')));
  } finally { await h.speech.close(); }
});

test('margin is configurable and invalid margins fail explicitly', async () => {
  const strict = harness();
  const noMargin = harness({ wearerMarginDb: 0 });
  try {
    for (const h of [strict, noMargin]) { h.push(500, 2000); h.say('When is lunch?', 0, 500); }
    assert.equal(strict.utterances[0]!.role, 'unknown');
    assert.equal(noMargin.utterances[0]!.role, 'wearer');
    for (const wearerMarginDb of [-1, NaN, Infinity]) assert.throws(() => harness({ wearerMarginDb }), /wearerMarginDb/);
  } finally { await strict.speech.close(); await noMargin.speech.close(); }
});

test('provider uncertainty overrides both calibrated loudness and known speaker labels', async () => {
  for (const provider of ['elevenlabs', 'deepgram'] as const) {
    const h = harness({ provider, wearerSpeaker: '0' });
    try {
      h.push(500); h.connections.at(-1)!.onUtterance({ text: 'When is lunch?', startMs: 0, endMs: 500, speaker: '0', uncertain: true });
      assert.equal(h.utterances[0]!.role, 'unknown');
      assert.equal(h.utterances[0]!.isWearer, false);
      assert.equal(h.questions.length, 0);
      assert.equal(h.pairs.length, 0);
    } finally { await h.speech.close(); }
  }
});

test('stale finals cannot replace the latest wearer question or reorder emitted answer candidates', async () => {
  const h = harness();
  try {
    h.push(1500); h.push(500, 500);
    h.say('Where is Mary?', 1000, 1500);
    h.say('When is lunch?', 0, 500);
    h.say('At the store.', 1500, 2000);
    h.say('At the store.', 1500, 2000);
    h.say('An earlier line.', 500, 1000);
    assert.deepEqual(h.questions.map(q => q.text), ['Where is Mary?']);
    assert.equal(h.pairs.length, 1);
    assert.equal(h.pairs[0]!.question.text, 'Where is Mary?');
    assert.deepEqual(h.utterances.map(u => u.role), ['wearer', 'unknown', 'other', 'unknown']);
  } finally { await h.speech.close(); }
});

test('the exact 30-second spoken boundary accepts a candidate and later speech expires it', async () => {
  const h = harness();
  try {
    h.push(500); h.say('When is lunch?', 0, 500);
    for (let i = 0; i < 3; i++) h.push(10_000, 0);
    h.push(500, 500);
    const sentEnd = h.sent.reduce((sum, frame) => sum + frame.length / 32, 0);
    h.say('At noon.', sentEnd - 500, sentEnd);
    assert.equal(h.pairs.length, 1);
    assert.equal(h.pairs[0]!.answer.startMs - h.pairs[0]!.question.endMs, 30_000);
    h.push(500, 500); h.say('Another answer.', sentEnd, sentEnd + 500);
    assert.equal(h.pairs.length, 1);
  } finally { await h.speech.close(); }
});

test('source clock ignores wall time before audio and across pause/resume', async () => {
  const h = harness();
  try {
    h.advance(90_000);
    h.push(500); h.say('When is lunch?', 0, 500);
    assert.equal(h.utterances[0]!.startMs, 0);
    h.speech.pause(); h.advance(120_000); h.speech.resume();
    h.push(500, 500); h.say('At noon.', 0, 500);
    assert.equal(h.utterances[1]!.startMs, 500);
    assert.equal(h.utterances[1]!.endMs, 1000);
    assert.equal(h.pairs.length, 0);
  } finally { await h.speech.close(); }
});

test('source clock counts PCM accepted during provider failure before a fresh connection resumes', async () => {
  const h = harness();
  try {
    h.push(500); h.say('When is lunch?', 0, 500);
    exhaustReconnects(h, new Error('lost connection')); // 3 x 100 ms of audio while reconnecting
    h.push(2000, 0); h.advance(90_000);
    h.speech.resume(); h.push(500, 500); h.say('At noon.', 0, 500);
    assert.equal(h.errors.length, 1);
    assert.equal(h.utterances[1]!.startMs, 2800);
    assert.equal(h.utterances[1]!.endMs, 3300);
    assert.equal(h.pairs.length, 0);
  } finally { await h.speech.close(); }
});

test('transcript latency follows PCM wall arrival across delayed startup and a pause', async () => {
  const measurements: { transcriptMs: number }[] = [];
  const h = harness({ onLatency: measurement => measurements.push(measurement) });
  try {
    h.advance(90_000); // Opening the app is not the first audio byte.
    h.push(1000);
    h.advance(200); h.say('When is lunch?', 0, 500);
    // The question ended halfway through the one-second input chunk.
    assert.equal(measurements[0]!.transcriptMs, 700);
    h.speech.pause(); h.advance(30_000); h.speech.resume();
    h.push(500); h.advance(150); h.say('Where is Mary?', 0, 500);
    assert.equal(h.utterances[1]!.startMs, 1000);
    assert.equal(h.utterances[1]!.endMs, 1500);
    assert.equal(measurements[1]!.transcriptMs, 150);
  } finally { await h.speech.close(); }
});

test('latency keeps the original chunk arrival when a later chunk follows a wall-time gap', async () => {
  const measurements: { transcriptMs: number }[] = [];
  const h = harness({ onLatency: measurement => measurements.push(measurement) });
  try {
    h.push(500);
    h.advance(5000); h.push(500, 500);
    h.say('When is lunch?', 0, 500);
    assert.equal(measurements[0]!.transcriptMs, 5500);
  } finally { await h.speech.close(); }
});

test('fake scripts support the main pipe format, named others, unknowns, and legacy TSV', () => {
  const main = readFakeScript();
  assert.equal(main[0]!.role, 'wearer');
  assert.equal(main[0]!.endMs, 2000);
  assert.equal(main[1]!.role, 'other');
  assert.equal(main[1]!.name, 'Sarah');
  const directory = mkdtempSync(join(tmpdir(), 'speech-fake-'));
  const path = join(directory, 'fixture.txt');
  try {
    writeFileSync(path, '  # comment\n1 | wearer | When is lunch?\n2 | Sarah | Noon | exactly.\n1 | unknown | Unclear.\n');
    const pipe = readFakeScript(path);
    assert.deepEqual(pipe.map(u => [u.endMs, u.role, u.isWearer, u.name, u.text]), [
      [1000, 'wearer', true, null, 'When is lunch?'], [3000, 'other', false, 'Sarah', 'Noon | exactly.'], [4000, 'unknown', false, null, 'Unclear.'],
    ]);
    // Role keywords are case-insensitive; names keep their case.
    writeFileSync(path, '1 | Wearer | When is lunch?\n1 | UNKNOWN | Unclear.\n1 | Sarah | Noon.\n');
    assert.deepEqual(readFakeScript(path).map(u => [u.role, u.name]), [['wearer', null], ['unknown', null], ['other', 'Sarah']]);
    writeFileSync(path, '500\twearer\t-\tWhen is lunch?\n1000\tother\tSarah\tAt noon.\n1500\tunknown\t-\tUnclear.\n');
    assert.deepEqual(readFakeScript(path).map(u => u.role), ['wearer', 'other', 'unknown']);
    for (const invalid of ['0 | wearer | Bad.', '-1 | Sarah | Bad.', 'x | unknown | Bad.', '1 | | Bad.', '500\tnobody\t-\tBad.']) {
      writeFileSync(path, invalid);
      assert.throws(() => readFakeScript(path), /Invalid fake script/);
    }
  } finally { unlinkSync(path); rmdirSync(directory); }
});

test('fake roles override legacy booleans and unknown lines do not consume the answer window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const utterances: Utterance[] = [];
  const questions: Utterance[] = [];
  const pairs: QAPair[] = [];
  const speech = createSpeechModule({ provider: 'fake', apiKey: '', fakeScript: [
    { text: 'When is lunch?', startMs: 0, endMs: 500, isWearer: false, role: 'wearer', name: null },
    { text: 'Unclear.', startMs: 500, endMs: 1000, isWearer: true, role: 'unknown', name: null },
    { text: 'At noon.', startMs: 1000, endMs: 1500, isWearer: false, role: 'other', name: 'Sarah' },
    { text: 'Do you mean lunch?', startMs: 1500, endMs: 2000, isWearer: false, role: 'other', name: 'Sarah' },
  ], onUtterance: u => utterances.push(u), onWearerQuestion: u => questions.push(u), onPair: p => pairs.push(p), onError: e => { throw e; } });
  try {
    for (let i = 0; i < 4; i++) t.mock.timers.tick(500);
    assert.deepEqual(utterances.map(u => u.role), ['wearer', 'unknown', 'other', 'other']);
    assert.ok(utterances.every(u => u.isWearer === (u.role === 'wearer')));
    assert.equal(questions.length, 1);
    assert.equal(pairs.length, 2);
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
