import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test, { after, type TestContext } from 'node:test';
import type { WebSocket } from 'ws';
import type { SessionDependencies } from '../src/session.js';
import type { SpeechOptions, Utterance } from '../src/speech/index.js';
import type { ServerMessage, VoiceRecord } from '../src/types.js';
import type { Voiceprint } from '../src/voices/client.js';
import type { NameFinding, NameLine } from '../src/voices/names.js';

// Dynamic imports keep the real store and dotenv isolated from developer data/keys.
const directory = await mkdtemp(join(tmpdir(), 'voices-tests-'));
process.env.DOTENV_CONFIG_PATH = join(directory, 'no-env-file');
process.env.DATA_FILE = join(directory, 'store.json');
process.env.SPEECH_PROVIDER = 'fake';
process.env.SPEECH_API_KEY = 'test-only';
process.env.SPEECH_WEARER_THRESHOLD_DB = '-25';
process.env.GEMINI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.TONE_URL = '';
process.env.VOICE_URL = '';
const { Gallery } = await import('../src/voices/gallery.js');
const { VoiceTracker } = await import('../src/voices/tracker.js');
const { mightHaveName, patternName, isWhoAreYou, whoIsName } = await import('../src/voices/names.js');
const { Session } = await import('../src/session.js');
const store = await import('../src/store.js');
after(async () => {
  store.flush();
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('voices-tests-'));
  await rm(directory, { recursive: true, force: true });
});

// Synthetic voiceprints: one axis per person, so scores are easy to reason about.
const DIM = 8;
const unit = (...xs: number[]) => { const v = Array.from({ length: DIM }, (_, i) => xs[i] ?? 0); const n = Math.hypot(...v); return v.map(x => x / n); };
const KEVIN = unit(1), SARAH = unit(0, 1), WEARER = unit(0, 0, 1);
const print = (v: number[], seconds = 4, halves = seconds >= 3): Voiceprint =>
  ({ whole: v, ...(halves ? { first: v, second: v } : {}), seconds, ms: 1 });
const memory = () => { const saved = new Map<string, VoiceRecord>(); return { saved, persist: { load: () => [...saved.values()], save: (v: VoiceRecord) => void saved.set(v.id, structuredClone(v)), remove: (id: string) => void saved.delete(id) } }; };
const evidence = { text: 'Hi, I\'m Kevin.', kind: 'self_intro' as const, confidence: 0.9, by: 'claude' as const, at: new Date().toISOString() };

test('gallery: matches above the threshold, and the current speaker keeps it a little below', () => {
  const g = new Gallery(memory().persist, 0.47);
  const kevin = g.createUnnamed(print(KEVIN)) as VoiceRecord;
  assert.equal(typeof kevin, 'object');
  assert.equal(g.identify(unit(1, 0.5), null).id, kevin.id); // 0.89
  const borderline = unit(1, 1.95); // 0.456: under 0.47, over 0.47 - 0.05
  assert.equal(g.identify(borderline, null).id, null);
  assert.equal(g.identify(borderline, kevin.id).id, kevin.id);
  assert.equal(g.identify(SARAH, kevin.id).id, null);
});

test('gallery: a new voice needs 3 s of one voice that is clearly nobody known', () => {
  const g = new Gallery(memory().persist, 0.47);
  assert.match(g.createUnnamed(print(KEVIN, 2)) as string, /only 2s/);
  assert.match(g.createUnnamed({ whole: KEVIN, first: KEVIN, second: SARAH, seconds: 4, ms: 1 }) as string, /two voices/);
  const kevin = g.createUnnamed(print(KEVIN)) as VoiceRecord;
  assert.equal(kevin.seq, 1);
  assert.match(g.createUnnamed(print(unit(1, 1.4))) as string, /partly like a known voice/); // 0.58 to Kevin
  assert.equal((g.createUnnamed(print(SARAH)) as VoiceRecord).seq, 2);
  assert.equal(g.list().length, 2);
});

test('gallery: lines that sound like the wearer are flagged, not taken for someone', () => {
  const g = new Gallery(memory().persist, 0.47);
  g.createUnnamed(print(KEVIN));
  assert.equal(g.addWearer(WEARER), true);
  assert.equal(g.addWearer(WEARER), false); // redundant
  const r = g.identify(unit(0.2, 0, 1), null);
  assert.equal(r.wearerLike, true);
  assert.equal(r.id, null);
  assert.match(g.createUnnamed(print(WEARER)) as string, /partly like a known voice/);
});

test('gallery: naming saves the voice; a second voice with the same name merges only if it sounds alike', () => {
  const { saved, persist } = memory();
  const g = new Gallery(persist, 0.47);
  const kevin = g.createUnnamed(print(KEVIN)) as VoiceRecord;
  assert.equal(saved.get(kevin.id)?.name, null); // unnamed voices are kept too, so a later name still finds them
  const named = g.assignName(kevin.id, 'kevin.', evidence);
  assert.ok(named.ok);
  assert.equal(saved.get(kevin.id)?.name, 'Kevin');
  assert.deepEqual(g.assignName(kevin.id, 'Bob', evidence), { ok: false, reason: 'already named Kevin' });

  const sarah = g.createUnnamed(print(SARAH)) as VoiceRecord;
  const refused = g.assignName(sarah.id, 'Kevin', evidence);
  assert.equal(refused.ok, false);
  assert.match((refused as { reason: string }).reason, /doesn't sound like the Kevin we know/);

  // The same Kevin sounding a bit different (0.31 to the saved sample): merges.
  const kevin2 = g.createUnnamed(print(unit(0.34, 0.3, 0, 0, 1))) as VoiceRecord;
  assert.equal(typeof kevin2, 'object');
  const merged = g.assignName(kevin2.id, 'Kevin', evidence);
  assert.ok(merged.ok && merged.merged);
  assert.equal(g.get(kevin2.id)?.id, kevin.id); // the merged id still resolves
  assert.equal(saved.get(kevin.id)?.samples.length, 2);

  // Restart: Kevin comes back from the store, and so does the unnamed voice whose name was refused.
  const again = new Gallery(persist, 0.47);
  assert.equal(again.identify(KEVIN, null).id, kevin.id);
  assert.deepEqual(again.list().map(v => v.name).sort(), ['Kevin', null]);
});

test('names: the cheap filter and the no-key patterns', () => {
  const line = (role: NameLine['role'], text: string): NameLine => ({ role, text, voice: null });
  assert.equal(mightHaveName([line('other', 'Lunch is at noon.')]), false);
  assert.equal(mightHaveName([line('other', 'Hi, I\'m Kevin.')]), true);
  assert.equal(mightHaveName([line('wearer', 'Thanks, Sarah.')]), true);
  assert.equal(mightHaveName([line('wearer', 'What\'s your name?'), line('other', 'kevin')]), true);
  assert.deepEqual(patternName([line('other', 'Hi, I\'m Kevin, from next door.')])?.name, 'Kevin');
  assert.equal(patternName([line('other', 'I\'m Fine thanks.')]), null);
  assert.equal(patternName([line('other', 'Mary is coming at five.')]), null);
  assert.deepEqual(patternName([line('wearer', 'Sorry, what is your name?'), line('other', 'It\'s Kevin.')]),
    { name: 'Kevin', kind: 'answer_to_name_question', confidence: 0.75, by: 'pattern' });
});

// ---- tracker: per-session flow with a scripted voice per audio range ----

const settle = () => new Promise<void>(done => setTimeout(done, 5));
function tracker(script: { fromMs: number; voice: number[] }[], names: Record<string, NameFinding | null> = {}) {
  const g = new Gallery(memory().persist, 0.47);
  const sent: ServerMessage[] = [];
  const voiceAt = (ms: number) => [...script].reverse().find(s => s.fromMs <= ms)!.voice;
  const t = new VoiceTracker({
    session: () => 'test',
    gallery: g,
    // The fake audio carries the end time; the fake service maps it to the scripted voice.
    clip: (startMs, endMs) => { const pcm = new Uint8Array(Math.round((endMs - startMs) * 32)); new DataView(pcm.buffer).setUint32(0, endMs); return pcm; },
    embed: async pcm => ({ ok: true, print: print(voiceAt(new DataView(pcm.buffer).getUint32(0) - 1), pcm.byteLength / 32_000) }),
    extractName: async lines => names[lines[lines.length - 1].text] ?? null,
    send: msg => void sent.push(msg),
  });
  let n = 0;
  const say = async (role: Utterance['role'], startMs: number, endMs: number, text: string) => {
    const u: Utterance = { id: `u${++n}`, role, isWearer: role === 'wearer', text, startMs, endMs, rmsDb: -30, speaker: null, name: null };
    t.onUtterance(u, `line-${n}`);
    await settle();
    return u;
  };
  return { g, t, sent, say };
}
const finding = (name: string, kind: NameFinding['kind']): NameFinding => ({ name, kind, confidence: 0.9, by: 'claude' });

test('tracker: a name said before there is enough voice waits for the voice, then later turns show it', async () => {
  const h = tracker([{ fromMs: 0, voice: KEVIN }], { 'Hi, I\'m Kevin.': finding('Kevin', 'self_intro') });
  await h.say('other', 0, 1200, 'Hi, I\'m Kevin.'); // 1.2 s: recognized as nobody, too short for a new voice
  assert.equal(h.g.list().length, 0);
  await h.say('other', 1500, 4500, 'I live next door, nice to meet you.'); // same turn, now 4.5 s
  const [kevin] = h.g.list();
  assert.equal(kevin?.name, 'Kevin');
  assert.deepEqual(h.sent.map(m => m.type === 'speaker' && m.name), ['Kevin']);

  await h.say('wearer', 6000, 7000, 'Oh, how lovely.');
  const later = await h.say('other', 9000, 11_000, 'I brought you some cookies.');
  assert.equal((await h.t.voiceFor(later.id, 100))?.name, 'Kevin');
  assert.equal(store.todaysTranscript().length, 0); // the tracker only patches lines the session added
});

test('tracker: "Thanks, Sarah" names whoever just spoke; a third-party mention names nobody', async () => {
  const h = tracker([{ fromMs: 0, voice: SARAH }], { 'Thanks, Sarah.': finding('Sarah', 'addressed_by_wearer') });
  await h.say('other', 0, 4000, 'Here is your coat, it is cold outside. Mary is coming at five.');
  assert.equal(h.g.list()[0].name, null);
  await h.say('wearer', 5000, 6000, 'Thanks, Sarah.');
  assert.equal(h.g.list()[0].name, 'Sarah');
});

test('tracker: a name the wearer uses before anyone spoke goes to the next speaker', async () => {
  const h = tracker([{ fromMs: 0, voice: KEVIN }], { 'Hi Kevin!': finding('Kevin', 'addressed_by_wearer') });
  await h.say('wearer', 0, 800, 'Hi Kevin!');
  await h.say('other', 2000, 6000, 'Good morning, how are you feeling today?');
  assert.equal(h.g.list()[0]?.name, 'Kevin');
});

// ---- session: a spoken pair takes the answerer's name from their voice ----

class Phone extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: ServerMessage[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  json(message: object) { this.emit('message', Buffer.from(JSON.stringify(message)), false); }
  audio(bytes: Buffer) { this.emit('message', bytes, true); }
  terminate() { this.readyState = 3; this.emit('close'); }
}

test('session: the stored pair says who answered, from the remembered voice', async (t: TestContext) => {
  let options!: SpeechOptions;
  const phone = new Phone();
  const deps: SessionDependencies = {
    createSpeech: value => { options = value; return { pushAudio() {}, pause() {}, resume() {}, close: async () => {} }; },
    findMatch: async question => ({ match: null, log: { question, decision: 'none', ms: 0 } }),
    isReply: async () => true, warm: async () => {}, analyzeQuestion: async () => null,
    embedVoice: async pcm => ({ ok: true, print: print(KEVIN, pcm.byteLength / 32_000) }),
    extractName: async lines => /Kevin/.test(lines[lines.length - 1].text) ? finding('Kevin', 'self_intro') : null,
  };
  new Session(phone as unknown as WebSocket, deps);
  t.after(() => phone.terminate());
  phone.json({ v: 1, type: 'hello', session: 'voices', source: 'glasses' });
  for (let i = 0; i < 100; i++) phone.audio(Buffer.alloc(3200)); // 10 s in the ring

  const u = (id: string, role: Utterance['role'], startMs: number, endMs: number, text: string): Utterance =>
    ({ id, role, isWearer: role === 'wearer', text, startMs, endMs, rmsDb: -30, speaker: null, name: null });
  options.onUtterance(u('a', 'other', 0, 4000, 'Hi, I\'m Kevin, your neighbor.'));
  await settle();
  const q = u('q', 'wearer', 5000, 6000, 'When is lunch?');
  options.onUtterance(q);
  options.onWearerQuestion(q);
  const answer = u('b', 'other', 6500, 8500, 'Lunch is at noon.');
  options.onUtterance(answer);
  options.onPair({ question: q, answer });
  await settle();
  await settle();
  const pair = store.todaysSpokenPairs().find(r => r.answer === 'Lunch is at noon.');
  assert.equal(pair?.answeredBy, 'Kevin');
  assert.ok(phone.sent.some(m => m.type === 'speaker' && m.name === 'Kevin'));
  assert.equal(store.todaysTranscript().find(l => l.text === 'Lunch is at noon.')?.name, 'Kevin');
});

test('session: an answer saved before its speaker was named gets the name when it is heard', async (t: TestContext) => {
  let options!: SpeechOptions;
  const phone = new Phone();
  const deps: SessionDependencies = {
    createSpeech: value => { options = value; return { pushAudio() {}, pause() {}, resume() {}, close: async () => {} }; },
    findMatch: async question => ({ match: null, log: { question, decision: 'none', ms: 0 } }),
    isReply: async () => true, warm: async () => {}, analyzeQuestion: async () => null,
    embedVoice: async pcm => ({ ok: true, print: print(unit(0, 0, 0, 1), pcm.byteLength / 32_000) }),
    extractName: async lines => /Thank you, Ana/.test(lines[lines.length - 1].text) ? finding('Ana', 'addressed_by_wearer') : null,
  };
  new Session(phone as unknown as WebSocket, deps);
  t.after(() => phone.terminate());
  phone.json({ v: 1, type: 'hello', session: 'voices-later', source: 'glasses' });
  for (let i = 0; i < 100; i++) phone.audio(Buffer.alloc(3200));

  const u = (id: string, role: Utterance['role'], startMs: number, endMs: number, text: string): Utterance =>
    ({ id, role, isWearer: role === 'wearer', text, startMs, endMs, rmsDb: -30, speaker: null, name: null });
  const q = u('q2', 'wearer', 0, 1000, 'Where are my glasses?');
  options.onUtterance(q);
  options.onWearerQuestion(q);
  const answer = u('a2', 'other', 1500, 5500, 'They are on the kitchen table.');
  options.onUtterance(answer);
  options.onPair({ question: q, answer });
  await settle();
  const pair = () => store.todaysSpokenPairs().find(r => r.answer === 'They are on the kitchen table.');
  assert.equal(pair()?.answeredBy, null);
  options.onUtterance(u('w2', 'wearer', 6000, 7000, 'Thank you, Ana.'));
  await settle();
  assert.equal(pair()?.answeredBy, 'Ana');
});

test('session: a reply too short to check on its own takes the voice of the rest of the turn', async (t: TestContext) => {
  let options!: SpeechOptions;
  const phone = new Phone();
  const deps: SessionDependencies = {
    createSpeech: value => { options = value; return { pushAudio() {}, pause() {}, resume() {}, close: async () => {} }; },
    findMatch: async question => ({ match: null, log: { question, decision: 'none', ms: 0 } }),
    isReply: async () => true, warm: async () => {}, analyzeQuestion: async () => null,
    embedVoice: async pcm => ({ ok: true, print: print(unit(0, 0, 0, 0, 1), pcm.byteLength / 32_000) }),
    extractName: async lines => /I'm Tom/.test(lines[lines.length - 1].text) ? finding('Tom', 'self_intro') : null,
  };
  new Session(phone as unknown as WebSocket, deps);
  t.after(() => phone.terminate());
  phone.json({ v: 1, type: 'hello', session: 'voices-short', source: 'glasses' });
  for (let i = 0; i < 100; i++) phone.audio(Buffer.alloc(3200));

  const u = (id: string, role: Utterance['role'], startMs: number, endMs: number, text: string): Utterance =>
    ({ id, role, isWearer: role === 'wearer', text, startMs, endMs, rmsDb: -30, speaker: null, name: null });
  const q = u('q3', 'wearer', 0, 1000, 'Who reads with me on Sundays?');
  options.onUtterance(q);
  options.onWearerQuestion(q);
  const short = u('a3', 'other', 1200, 2000, 'Hi, I\'m Tom.');
  options.onUtterance(short);
  options.onUtterance(u('b3', 'other', 2200, 6000, 'I come by every Sunday to read with you.'));
  options.onPair({ question: q, answer: short });
  await settle();
  await settle();
  assert.equal(store.todaysSpokenPairs().find(r => r.answer === 'Hi, I\'m Tom.')?.answeredBy, 'Tom');
});

test('tracker: a known visitor is shown even when the glasses tag his line "self" or "unknown"; he never becomes the wearer', async () => {
  const h = tracker([{ fromMs: 0, voice: KEVIN }, { fromMs: 20_000, voice: WEARER }], { 'Hi, I\'m Kevin.': finding('Kevin', 'self_intro') });
  await h.say('other', 0, 4000, 'Hi, I\'m Kevin.');
  assert.equal(h.g.list()[0]?.name, 'Kevin');
  const heardBefore = h.g.list()[0].heard;
  await h.say('wearer', 6000, 8000, 'The weather is quite lovely today.'); // Kevin, mislabeled by the glasses
  await h.say('unknown', 10_000, 12_000, 'Lunch is at noon.'); // Kevin again, unsure tag
  assert.equal(h.t.snapshot().live?.voice, 'Kevin');
  assert.equal(h.g.wearerSamples, 0); // a visitor's line never teaches the wearer's voice
  assert.ok(h.sent.some(m => m.type === 'speaker' && m.name === 'Kevin'));
  await h.say('wearer', 20_000, 22_000, 'It is not showing who is speaking.'); // the real wearer
  assert.equal(h.g.wearerSamples, 1);
  assert.equal(h.g.list()[0].heard, heardBefore); // tagged lines show the name but don't count as samples
});

test('names: questions about who someone is', () => {
  for (const q of ['Who are you?', 'Sorry, who are you?', "What's your name again?", 'Who is this?', 'Remind me who you are.'])
    assert.equal(isWhoAreYou(q), true, q);
  for (const q of ['Who is coming today?', 'Who are you going with?', 'Where are you?']) assert.equal(isWhoAreYou(q), false, q);
  assert.equal(whoIsName('Who is Kevin?'), 'Kevin');
  assert.equal(whoIsName("Who's the Kevin?"), 'Kevin');
  assert.equal(whoIsName('Who is this?'), null);
  assert.equal(whoIsName('Who is coming over today?'), null);
});

test('tracker: "Who is Kevin?" shows what Kevin said about himself; "Who are you?" names whoever just talked', async () => {
  const h = tracker([{ fromMs: 0, voice: KEVIN }], { "Hi, I'm Kevin.": finding('Kevin', 'self_intro') });
  await h.say('other', 0, 1200, "Hi, I'm Kevin.");
  await h.say('other', 1400, 4500, "I'm your neighbor from the blue house next door.");
  await h.say('other', 4700, 9000, 'I come by every Sunday to check on you and bring you the newspaper.');
  const kevin = h.g.byName('kevin');
  assert.equal(kevin?.about?.text, "Hi, I'm Kevin. I'm your neighbor from the blue house next door."); // whole sentences, under 100 characters
  assert.deepEqual(h.t.answerWho("Who's the Kevin?", 20_000)?.text, kevin?.about?.text);
  assert.equal(h.t.answerWho('Sorry, who are you?', 20_000)?.name, 'Kevin');
  assert.equal(h.t.answerWho('Who are you?', 60_000), null); // nobody talked in the last 30 s
  assert.equal(h.t.answerWho('Who is Mary?', 20_000), undefined); // unknown: the matcher may still know
  assert.equal(h.t.answerWho('When is lunch?', 20_000), undefined);
});

test('session: "Who are you?" is never stored as a pair', async (t: TestContext) => {
  let options!: SpeechOptions;
  const phone = new Phone();
  const deps: SessionDependencies = {
    createSpeech: value => { options = value; return { pushAudio() {}, pause() {}, resume() {}, close: async () => {} }; },
    findMatch: async question => ({ match: null, log: { question, decision: 'none', ms: 0 } }),
    isReply: async () => true, warm: async () => {}, analyzeQuestion: async () => null,
    embedVoice: async pcm => ({ ok: true, print: print(unit(0, 0, 0, 0, 0, 1), pcm.byteLength / 32_000) }),
    extractName: async () => null,
  };
  new Session(phone as unknown as WebSocket, deps);
  t.after(() => phone.terminate());
  phone.json({ v: 1, type: 'hello', session: 'voices-who', source: 'glasses' });
  for (let i = 0; i < 100; i++) phone.audio(Buffer.alloc(3200));
  const u = (id: string, role: Utterance['role'], startMs: number, endMs: number, text: string): Utterance =>
    ({ id, role, isWearer: role === 'wearer', text, startMs, endMs, rmsDb: -30, speaker: null, name: null });
  const q = u('q9', 'wearer', 0, 1000, 'Sorry, who are you?');
  options.onUtterance(q);
  options.onWearerQuestion(q);
  const a = u('a9', 'other', 1500, 4500, "Hi, I'm Dora, the new nurse.");
  options.onUtterance(a);
  options.onPair({ question: q, answer: a });
  await settle();
  assert.equal(store.allRecords().some(r => r.answer === "Hi, I'm Dora, the new nurse."), false);
});

test('tracker: a voice remembered without a name gets it later, even from a line too short to check', async () => {
  const { persist } = memory();
  const g = new Gallery(persist, 0.47);
  const sent: ServerMessage[] = [];
  const t = new VoiceTracker({
    session: () => 'test', gallery: g,
    clip: (startMs, endMs) => new Uint8Array(Math.round((endMs - startMs) * 32)),
    embed: async pcm => ({ ok: true, print: print(KEVIN, pcm.byteLength / 32_000) }),
    extractName: async lines => lines[lines.length - 1].text === "I'm Kevin." ? finding('Kevin', 'self_intro') : null,
    send: msg => void sent.push(msg),
  });
  let n = 0;
  const say = async (role: Utterance['role'], startMs: number, endMs: number, text: string) => {
    t.onUtterance({ id: `s${++n}`, role, isWearer: role === 'wearer', text, startMs, endMs, rmsDb: -30, speaker: null, name: null }, `l${n}`);
    await settle();
  };
  await say('other', 0, 5000, 'I come by every Sunday to read the paper with you.');
  assert.equal(g.list()[0]?.name, null); // remembered, no name yet
  // A restart keeps the unnamed voice.
  assert.equal(new Gallery(persist, 0.47).list().length, 1);
  await say('wearer', 6000, 7000, 'Who are you again?');
  await say('other', 8000, 8400, "I'm Kevin."); // 0.4 s: too short to check by voice
  await say('wearer', 9000, 10_000, 'Oh, nice.'); // the turn ends
  await settle();
  assert.equal(g.list()[0]?.name, 'Kevin');
  assert.equal(g.list().length, 1);
});

test('tracker: "I\'m Kevin." said first after a long break goes to the unnamed voice heard right after', async () => {
  const { persist } = memory();
  const g = new Gallery(persist, 0.47);
  const anon = g.createUnnamed(print(KEVIN)) as VoiceRecord; // remembered an hour ago, no name
  const t = new VoiceTracker({
    session: () => 'test', gallery: g,
    clip: (startMs, endMs) => new Uint8Array(Math.round((endMs - startMs) * 32)),
    // Like the real service: a padded 0.4 s line holds under 0.6 s of speech.
    embed: async pcm => pcm.byteLength < 1.1 * 32_000 ? { ok: false, reason: 'too_short' } : { ok: true, print: print(KEVIN, pcm.byteLength / 32_000) },
    extractName: async lines => lines[lines.length - 1].text === "I'm Kevin." ? finding('Kevin', 'self_intro') : null,
    send: () => {},
  });
  let n = 0;
  const say = async (role: Utterance['role'], startMs: number, endMs: number, text: string) => {
    t.onUtterance({ id: `o${++n}`, role, isWearer: role === 'wearer', text, startMs, endMs, rmsDb: -30, speaker: null, name: null }, `m${n}`);
    await settle();
  };
  await say('other', 0, 400, "I'm Kevin."); // too short, nobody heard before it
  await say('wearer', 1000, 2000, 'Oh, hello.');
  await settle();
  assert.equal(g.get(anon.id)?.name, null);
  await say('other', 3000, 7000, 'I come by on Sundays to read the paper with you.'); // recognized as the anonymous voice
  assert.equal(g.get(anon.id)?.name, 'Kevin');
});

test('gallery: a voice recorded on the dashboard is named, added to, or refused', () => {
  const g = new Gallery(memory().persist, 0.47);
  const anon = g.createUnnamed(print(SARAH)) as VoiceRecord;
  const named = g.enroll('sarah', print(SARAH));
  assert.ok(named.ok && named.how === 'named' && named.voice.id === anon.id && named.voice.name === 'Sarah');
  const fresh = g.enroll('Kevin', print(KEVIN));
  assert.ok(fresh.ok && fresh.how === 'new');
  const again = g.enroll('Kevin', print(unit(1, 0.3)));
  assert.ok(again.ok && again.how === 'added' && again.voice.samples.length === 2);
  assert.match((g.enroll('Bob', print(KEVIN)) as { reason: string }).reason, /sounds like Kevin/);
  assert.match((g.enroll('Ann', { whole: KEVIN, first: KEVIN, second: SARAH, seconds: 8, ms: 1 }) as { reason: string }).reason, /two voices/);
  assert.match((g.enroll('Ann', print(WEARER, 2)) as { reason: string }).reason, /only 2s of speech/);
});

test('tracker: recording a voice from the glasses takes the audio of the recording window', async () => {
  const g = new Gallery(memory().persist, 0.47);
  let clock = 5000;
  const clips: [number, number][] = [];
  const t = new VoiceTracker({
    session: () => 'test', gallery: g,
    clip: (startMs, endMs) => { clips.push([startMs, endMs]); return new Uint8Array(Math.round((endMs - startMs) * 32)); },
    audioClock: () => clock,
    embed: async pcm => ({ ok: true, print: print(KEVIN, pcm.byteLength / 32_000) }),
    extractName: async () => null,
    send: () => {},
  });
  assert.equal(t.startEnroll('Kevin', 0.05), true);
  assert.equal(t.startEnroll('Kevin', 0.05), false); // one at a time
  assert.equal(t.snapshot().enrollment?.state, 'recording');
  clock = 17_000; // 12 s of audio arrived
  await new Promise(done => setTimeout(done, 120));
  assert.deepEqual(clips.at(-1), [5000, 17_000]);
  assert.equal(t.snapshot().enrollment?.state, 'done');
  assert.equal(g.byName('kevin')?.samples.length, 1);
});
