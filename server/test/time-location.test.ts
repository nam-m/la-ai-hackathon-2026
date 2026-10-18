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

// Dynamic imports keep the real store and dotenv isolated from developer data/keys.
const directory = await mkdtemp(join(tmpdir(), 'time-location-tests-'));
process.env.DOTENV_CONFIG_PATH = join(directory, 'no-env-file');
process.env.DATA_FILE = join(directory, 'store.json');
process.env.SPEECH_PROVIDER = 'fake';
process.env.SPEECH_API_KEY = 'test-only';
process.env.SPEECH_WEARER_THRESHOLD_DB = '-25';
process.env.GEMINI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.TONE_URL = '';
process.env.VOICE_URL = '';
process.env.TIMEZONE = 'America/Los_Angeles';
const { dayOf, dayLabel, localDay } = await import('../src/when.js');
const { isWhereAmI, locationText } = await import('../src/location/index.js');
const { toPlace } = await import('../src/location/geocode.js');
const { mightUpdate } = await import('../src/updates.js');
const { findMatch } = await import('../src/matcher.js');
const { Session, answerMessage } = await import('../src/session.js');
const store = await import('../src/store.js');
after(async () => {
  store.flush();
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('time-location-tests-'));
  await rm(directory, { recursive: true, force: true });
});

// Sunday 2026-10-18, 10:00 in Los Angeles.
const NOW = new Date('2026-10-18T17:00:00Z');
const clear = () => { for (const r of [...store.allRecords()]) store.remove(r.id); };
const record = (id: string, question: string, answer: string, patch: Partial<QARecord> = {}): QARecord => {
  const now = new Date().toISOString();
  return { id, question, answer, askedAt: now, answeredAt: now, answeredBy: null, source: 'spoken', standing: false, ...patch };
};

test('when: the day a line names, in the wearer\'s time zone', () => {
  assert.equal(localDay(NOW), '2026-10-18');
  assert.equal(dayOf('Dinner tomorrow is at 7.', NOW), '2026-10-19');
  assert.equal(dayOf('Dinner is at 7 tonight.', NOW), '2026-10-18');
  assert.equal(dayOf('The day after tomorrow we see the doctor.', NOW), '2026-10-20');
  assert.equal(dayOf('Church is on Sunday.', NOW), '2026-10-18'); // today is Sunday
  assert.equal(dayOf('We go next Sunday.', NOW), '2026-10-25');
  assert.equal(dayOf('Leo comes on Wednesday.', NOW), '2026-10-21');
  assert.equal(dayOf('You saw Leo yesterday.', NOW), null);
  assert.equal(dayOf('Lunch is at noon.', NOW), null);
  // 11:30 PM Saturday local is still Saturday, although it is Sunday in UTC.
  assert.equal(dayOf('Dinner tomorrow is at 7.', new Date('2026-10-18T06:30:00Z')), '2026-10-18');
});

test('when: older answers say which day they were given', () => {
  assert.equal(dayLabel('2026-10-18T16:00:00Z', NOW), undefined);
  assert.equal(dayLabel('2026-10-17T20:00:00Z', NOW), 'yesterday');
  assert.equal(dayLabel('2026-10-14T20:00:00Z', NOW), 'on Wednesday');
  assert.equal(dayLabel('2026-10-02T20:00:00Z', NOW), 'on Oct 2');
});

test('store: an answer about tomorrow lives through tomorrow, then expires', () => {
  clear();
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  store.upsert(record('about-today', 'When is dinner?', 'Dinner tomorrow is at 7.', { answeredAt: yesterday, forDate: localDay() }));
  store.upsert(record('stale', 'When is lunch?', 'Lunch is at noon.', { answeredAt: yesterday }));
  store.upsert(record('ended', 'When is church?', 'Church is today at 10.', { answeredAt: yesterday, forDate: localDay(new Date(), -1) }));
  assert.ok(store.get('about-today'));
  assert.equal(store.get('stale'), undefined);
  assert.equal(store.get('ended'), undefined);
});

test('matcher: only answers about the day asked about', async () => {
  clear();
  store.upsert(record('dinner-today', 'When is dinner?', 'Dinner is at 6.'));
  store.upsert(record('dinner-tomorrow', 'When is dinner?', 'Dinner tomorrow is at 7.', { forDate: localDay(new Date(), 1) }));
  store.upsert(record('home', 'Where do I live?', 'You live at 12 Oak Street.', { source: 'family', standing: true }));
  assert.equal((await findMatch('When is dinner?')).match?.record.id, 'dinner-today');
  assert.equal((await findMatch('When is dinner tomorrow?')).match?.record.id, 'dinner-tomorrow');
  assert.equal((await findMatch('Where do I live tomorrow?')).match?.record.id, 'home'); // standing facts hold every day
});

test('answer message: an answer from yesterday says so', () => {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  const msg = answerMessage(record('y', 'When is dinner?', 'Dinner tomorrow is at 7.', { answeredAt: yesterday, answeredBy: 'Sarah' }));
  assert.equal(msg.type === 'answer' && msg.day, 'yesterday');
  const today = answerMessage(record('t', 'When is lunch?', 'At noon.'));
  assert.equal(today.type === 'answer' && 'day' in today, false);
});

test('location: which questions ask where the wearer is', () => {
  for (const q of ['Where am I?', 'Where am I right now?', 'Um, where are we?', 'What is this place?', "Where's this?", 'Where am I again?'])
    assert.equal(isWhereAmI(q), true, q);
  for (const q of ['Where are we going today?', 'Where am I going?', 'Where is Mary?', 'Where do I live?', 'Where are my keys?'])
    assert.equal(isWhereAmI(q), false, q);
});

test('location: a nearby shop is not where you are; a building you are in is', () => {
  const node = toPlace({ name: "Carl's Jr.", osm_type: 'node', address: { amenity: "Carl's Jr.", house_number: '308', road: 'Westwood Plaza', suburb: 'Westwood', city: 'Los Angeles' } });
  assert.deepEqual([node?.area, node?.street, node?.neighborhood], [null, '308 Westwood Plaza', 'Westwood']);
  const way = toPlace({ name: 'Pauley Pavilion', osm_type: 'way', address: { building: 'Pauley Pavilion', road: 'Westwood Plaza', city: 'Los Angeles' } });
  assert.equal(way?.area, 'Pauley Pavilion');
});

test('location: what the glasses say, with and without a home', () => {
  const fix = { lat: 34.0700, lon: -118.4440, accuracy: 12, at: new Date().toISOString() };
  const place = toPlace({ osm_type: 'node', address: { house_number: '308', road: 'Westwood Plaza', suburb: 'Westwood', city: 'Los Angeles' } });
  const home = { lat: 34.0640, lon: -118.4440, label: '12 Oak Street', at: fix.at }; // ~670 m south
  assert.equal(locationText(fix, place, home), "You're at 308 Westwood Plaza, 0.4 miles from home.");
  assert.equal(locationText(fix, place, null), "You're at 308 Westwood Plaza, Westwood.");
  assert.equal(locationText({ ...fix, lat: 34.0645 }, place, home), "You're at home.");
  assert.equal(locationText(fix, null, null), null);
  const long = toPlace({ name: 'A'.repeat(120), osm_type: 'way', address: { road: 'X' } });
  assert.equal(locationText(fix, long, null), null); // never cut: nothing rather than "See phone" for a place name
});

test('updates: the cheap filter wants a shared topic and a sign of news', () => {
  const lunch = record('l', 'When is lunch?', 'Lunch is at noon.');
  const mary = record('m', 'Where is Mary?', 'Mary is at the store.');
  assert.deepEqual(mightUpdate('Lunch moved to 1 today.', [lunch, mary]).map(r => r.id), ['l']);
  assert.deepEqual(mightUpdate('Mary is back now.', [lunch, mary]).map(r => r.id), ['m']);
  assert.deepEqual(mightUpdate('It is a lovely day.', [lunch, mary]), []);
  assert.deepEqual(mightUpdate('Lunch was nice.', [lunch, mary]), []); // no news
});

// ---- session ----

class Phone extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: ServerMessage[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  json(message: object) { this.emit('message', Buffer.from(JSON.stringify(message)), false); }
  terminate() { this.readyState = 3; this.emit('close'); }
}
const settle = () => new Promise<void>(done => setTimeout(done, 10));
function harness(t: TestContext, overrides: Partial<SessionDependencies> = {}) {
  let options!: SpeechOptions;
  const phone = new Phone();
  const deps: SessionDependencies = {
    createSpeech: value => { options = value; return { pushAudio() {}, pause() {}, resume() {}, close: async () => {} }; },
    findMatch: async question => ({ match: null, log: { question, decision: 'none', ms: 0 } }),
    isReply: async () => true, warm: async () => {}, analyzeQuestion: async () => null,
    geocode: async () => toPlace({ osm_type: 'node', address: { house_number: '308', road: 'Westwood Plaza', suburb: 'Westwood' } }),
    ...overrides,
  };
  new Session(phone as unknown as WebSocket, deps);
  t.after(() => phone.terminate());
  phone.json({ v: 1, type: 'hello', session: t.name, source: 'glasses' });
  return { phone, get speech() { return options; } };
}
const u = (id: string, role: Utterance['role'], startMs: number, text: string): Utterance =>
  ({ id, role, isWearer: role === 'wearer', text, startMs, endMs: startMs + 1000, rmsDb: -30, speaker: null, name: null });

test('session: "Where am I?" is answered from the phone\'s location, labeled as location', async t => {
  store.setSettings({ home: undefined });
  const h = harness(t);
  const ask = u('w1', 'wearer', 0, 'Where am I?');
  h.speech.onUtterance(ask);
  h.speech.onWearerQuestion(ask);
  await settle();
  assert.equal(h.phone.sent.some(m => m.type === 'answer'), false); // no location yet: nothing shown

  h.phone.json({ v: 1, type: 'location', latitude: 34.07, longitude: -118.444, accuracy: 12, at: new Date().toISOString() });
  await settle();
  const again = u('w2', 'wearer', 2000, 'Where am I right now?');
  h.speech.onUtterance(again);
  h.speech.onWearerQuestion(again);
  await settle();
  const answer = h.phone.sent.find(m => m.type === 'answer');
  assert.equal(answer?.type === 'answer' && answer.source, 'location');
  assert.equal(answer?.type === 'answer' && answer.text, "You're at 308 Westwood Plaza, Westwood.");
});

test('session: a pair about tomorrow is stored for tomorrow', async t => {
  clear();
  const h = harness(t);
  const q = u('q1', 'wearer', 0, 'When is dinner?');
  h.speech.onUtterance(q);
  h.speech.onWearerQuestion(q);
  const a = u('a1', 'other', 1500, 'Dinner tomorrow is at 7.');
  h.speech.onUtterance(a);
  h.speech.onPair({ question: q, answer: a });
  await settle();
  assert.equal(store.allRecords().find(r => r.answer === 'Dinner tomorrow is at 7.')?.forDate, localDay(new Date(), 1));
});

test('session: an update nobody asked for is saved word for word as the newest answer', async t => {
  clear();
  store.upsert(record('lunch', 'When is lunch?', 'Lunch is at noon.', { answeredAt: new Date(Date.now() - 60_000).toISOString() }));
  const checked: string[] = [];
  const h = harness(t, { findUpdate: async (text, candidates) => { checked.push(text); return /moved/.test(text) ? candidates[0] : null; } });
  h.speech.onUtterance(u('o1', 'other', 0, 'Lunch moved to 1 today.'));
  h.speech.onUtterance(u('o2', 'other', 2000, 'What a lovely garden.'));
  await settle();
  const update = store.allRecords().find(r => r.replaces === 'lunch');
  assert.equal(update?.question, 'When is lunch?');
  assert.equal(update?.answer, 'Lunch moved to 1 today.');
  assert.equal(update?.forDate, localDay());
  assert.deepEqual(checked, ['Lunch moved to 1 today.']); // the garden line never reached the model

  // A reply that isn't a reply to the open question is checked too.
  const h2 = harness(t, { isReply: async () => false, findUpdate: async (_text, candidates) => candidates.find(r => r.id === 'lunch') ?? null });
  const q = u('q2', 'wearer', 0, 'Where are my keys?');
  h2.speech.onUtterance(q);
  h2.speech.onWearerQuestion(q);
  const a = u('a2', 'other', 1500, 'Oh and lunch is at 2 now.');
  h2.speech.onUtterance(a);
  h2.speech.onPair({ question: q, answer: a });
  await settle();
  assert.ok(store.allRecords().some(r => r.answer === 'Oh and lunch is at 2 now.' && r.replaces === 'lunch'));
});
