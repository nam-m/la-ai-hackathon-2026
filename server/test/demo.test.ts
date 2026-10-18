import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test, { after } from 'node:test';

// Dynamic imports keep the real store and dotenv isolated from developer data/keys.
const directory = await mkdtemp(join(tmpdir(), 'demo-tests-'));
process.env.DOTENV_CONFIG_PATH = join(directory, 'no-env-file');
process.env.DATA_FILE = join(directory, 'store.json');
process.env.TIMEZONE = 'America/Los_Angeles';
process.env.GEMINI_API_KEY = '';
process.env.TONE_URL = '';
const store = await import('../src/store.js');
const { seedDemo, isDemo } = await import('../src/demo.js');
after(async () => {
  store.flush();
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('demo-tests-'));
  await rm(directory, { recursive: true, force: true });
});

const everything = () => store.between('', '~');
const demoEvents = () => everything().events.filter(e => isDemo(e.id));

test('every demo timestamp is on the seed day and not in the future', () => {
  for (const nowIso of ['2026-10-18T07:30:00Z', '2026-10-19T06:50:00Z', '2026-10-18T19:00:00Z']) { // 00:30, 23:50, 12:00 PDT
    const now = new Date(nowIso);
    seedDemo(now);
    const day = store.localDate(nowIso);
    const { transcript, events, tones } = everything();
    const records = store.allRecords().filter(r => isDemo(r.id));
    const stamps = [
      ...transcript.map(l => l.at), ...events.map(e => e.at), ...tones.map(t => t.at),
      ...records.flatMap(r => [r.askedAt, r.answeredAt, r.remindAt ?? r.answeredAt]),
    ];
    assert.ok(stamps.length > 20);
    for (const at of stamps) {
      assert.equal(store.localDate(at), day, `${at} is not on ${day} (now ${nowIso})`);
      assert.ok(Date.parse(at) <= now.getTime(), `${at} is after ${nowIso}`);
    }
    assert.equal(store.getDay(day)?.summary?.demo, true);
  }
});

test('lunch and Mary asks link to shared records; only the last Mary ask is a contradiction', () => {
  seedDemo(new Date('2026-10-18T19:00:00Z'));
  const links = (e: ReturnType<typeof demoEvents>[number]) =>
    [e.matchedRecordId, e.answerRecordId, e.contradiction?.spokenRecordId, e.contradiction?.factRecordId].filter(Boolean);
  const lunch = demoEvents().filter(e => e.id.startsWith('demo_qe_lunch'));
  assert.equal(lunch.length, 4);
  for (const e of lunch) assert.ok(links(e).includes('demo_qa_lunch'));
  assert.equal(lunch.filter(e => e.contradiction).length, 0);
  assert.equal(store.allRecords().find(r => r.id === 'demo_fact_lunch')?.answer, 'Lunch is at noon.');
  const mary = demoEvents().filter(e => e.id.startsWith('demo_qe_mary'));
  assert.equal(mary.length, 4);
  for (const e of mary) assert.ok(links(e).includes('demo_fact_mary'));
  assert.deepEqual(demoEvents().filter(e => e.contradiction).map(e => [e.id, e.contradiction]),
    [['demo_qe_mary4', { spokenRecordId: 'demo_qa_mary', factRecordId: 'demo_fact_mary' }]]);
  assert.match(store.allRecords().find(r => r.id === 'demo_qa_mary')?.answer ?? '', /pharmacy/);
  for (const e of demoEvents()) assert.ok(e.toneId, `${e.id} has no tone`);
});

test('re-seeding replaces the demo day and leaves real data alone', () => {
  const now = new Date('2026-10-18T19:00:00Z');
  store.upsert({
    id: 'qa_real', question: 'Is it Tuesday?', answer: 'It is.', askedAt: now.toISOString(), answeredAt: now.toISOString(),
    answeredBy: 'Sarah', source: 'spoken', standing: false,
  });
  store.addEvent({ id: 'qe_real', at: now.toISOString(), question: 'Is it Tuesday?', matchedRecordId: null, matchScore: null });
  seedDemo(now);
  const counts = () => [demoEvents().length, everything().tones.filter(t => isDemo(t.id)).length, store.allRecords().filter(r => isDemo(r.id)).length];
  const first = counts();
  seedDemo(now);
  assert.deepEqual(counts(), first);
  assert.ok(store.allRecords().some(r => r.id === 'qa_real'));
  assert.ok(everything().events.some(e => e.id === 'qe_real'));
});

test('a real summary is never replaced by the demo one', () => {
  const now = new Date('2026-10-20T19:00:00Z');
  const day = store.localDate(now.toISOString());
  store.saveSummary(day, { date: day, summary: 'From Creao.' });
  seedDemo(now);
  assert.equal(store.getDay(day)?.summary?.summary, 'From Creao.');
});

test('clearDemo removes the demo day and its summary, and nothing else', async () => {
  const { clearDemo } = await import('../src/demo.js');
  const now = new Date('2026-10-21T19:00:00Z');
  const day = store.localDate(now.toISOString());
  seedDemo(now);
  clearDemo();
  assert.equal(store.allRecords().filter(r => isDemo(r.id)).length, 0);
  assert.equal(demoEvents().length, 0);
  assert.equal(everything().tones.filter(t => isDemo(t.id)).length, 0);
  assert.equal(store.getDay(day)?.summary, undefined);
  assert.equal(store.getDay(store.localDate('2026-10-20T19:00:00Z'))?.summary?.summary, 'From Creao.');
  assert.ok(store.allRecords().some(r => r.id === 'qa_real'));
});

test('re-saving a reminder at the same time keeps its status, even after a delete (undo)', async () => {
  const { saveFacts } = await import('../src/facts.js');
  const remindAt = '2026-10-18T16:00:00.000Z';
  const input = { id: 'rem_pills', question: null, answer: 'Pills.', answeredBy: 'Sarah', standing: false, remindAt, expiresAt: null };
  const status = () => store.allRecords().find(r => r.id === 'rem_pills')?.reminderStatus;
  saveFacts([input]);
  store.upsert({ ...store.allRecords().find(r => r.id === 'rem_pills')!, reminderStatus: 'sent', reminderDoneAt: remindAt });
  saveFacts([input]);
  assert.equal(status(), 'sent');
  store.remove('rem_pills');
  saveFacts([input]); // the dashboard's undo
  assert.equal(status(), 'sent');
  saveFacts([{ ...input, remindAt: '2026-10-18T17:00:00.000Z' }]); // moved: a new reminder
  assert.equal(status(), undefined);
});

test('a demo day seeded just after midnight still has distinct, ordered times', () => {
  for (const nowIso of ['2026-10-22T07:00:40Z', '2026-10-22T07:02:30Z']) { // 00:00:40 and 00:02:30 PDT
    const now = new Date(nowIso);
    seedDemo(now);
    const times = demoEvents().map(e => e.at);
    assert.equal(new Set(times).size, times.length, `duplicate times at ${nowIso}`);
    for (const at of times) {
      assert.equal(store.localDate(at), store.localDate(nowIso));
      assert.ok(Date.parse(at) <= now.getTime());
    }
  }
});
