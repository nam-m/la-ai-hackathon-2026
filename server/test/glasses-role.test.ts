import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoleTimeline } from '../src/glasses-role.js';
import { createSpeechModule, type QAPair, type Utterance } from '../src/speech/index.js';
import type { ProviderOptions } from '../src/speech/types.js';

const FRAME = 3200; // 100 ms of 16 kHz mono s16le, as the phone sends it

function timeline(...runs: [role: 'self' | 'other' | 'unknown' | null, frames: number][]) {
  const t = new RoleTimeline();
  for (const [role, frames] of runs) {
    if (role) t.set(role);
    for (let i = 0; i < frames; i++) t.addAudio(FRAME);
  }
  return t;
}

test('glasses tags: majority over the utterance decides', () => {
  const t = timeline(['self', 10], ['other', 10]);
  assert.equal(t.roleAt(0, 1000), 'wearer');
  assert.equal(t.roleAt(1000, 2000), 'other');
  assert.equal(t.roleAt(200, 1100), 'wearer'); // 800 ms self, 100 ms other
  assert.equal(t.roleAt(500, 1500), 'unknown'); // half and half
});

test('glasses tags: unknown frames count against both sides', () => {
  const t = timeline(['self', 5], ['unknown', 5]);
  assert.equal(t.roleAt(0, 1000), 'unknown');
});

test('glasses tags: too little tagged audio defers to loudness', () => {
  const t = timeline([null, 10], ['self', 3]); // the phone started tagging late
  assert.equal(t.roleAt(0, 1300), undefined);
  assert.equal(t.roleAt(1000, 1300), 'wearer');
  assert.equal(new RoleTimeline().roleAt(0, 1000), undefined);
  assert.equal(t.roleAt(500, 500), undefined);
});

test('glasses tags: a tag applies until the next one and survives 60 s, not more', () => {
  const t = timeline(['other', 1], [null, 700]); // 70.1 s, all still "other"
  assert.equal(t.roleAt(69_000, 70_000), 'other');
  assert.equal(t.roleAt(0, 1000), undefined); // rolled off
});

function speech(roleAt: (startMs: number, endMs: number) => 'wearer' | 'other' | 'unknown' | undefined) {
  const connections: ProviderOptions[] = [];
  const utterances: Utterance[] = [];
  const questions: Utterance[] = [];
  const pairs: QAPair[] = [];
  const s = createSpeechModule({ provider: 'elevenlabs', apiKey: 'local-test', wearerThresholdDb: -25, roleAt,
    onUtterance: u => utterances.push(u), onWearerQuestion: q => questions.push(q), onPair: p => pairs.push(p), onError: () => undefined,
    providerFactory: options => { connections.push(options); return { sendAudio: () => undefined, close: async () => undefined }; } });
  const loud = Buffer.alloc(500 * 32);
  for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(6000, i);
  return {
    s, utterances, questions, pairs,
    say(text: string, startMs: number, endMs: number) {
      s.pushAudio(loud);
      connections.at(-1)!.onUtterance({ text, startMs, endMs, speaker: null });
    },
  };
}

test('speech: glasses roles decide before loudness, and pairs follow them', async () => {
  // Both lines are equally loud, so loudness alone would call both the wearer.
  const h = speech((startMs) => (startMs < 500 ? 'wearer' : 'other'));
  try {
    h.say('What time is lunch?', 0, 500);
    h.say('Lunch is at noon.', 500, 1000);
    assert.deepEqual(h.utterances.map(u => u.role), ['wearer', 'other']);
    assert.equal(h.questions.length, 1);
    assert.equal(h.pairs.length, 1);
    assert.equal(h.pairs[0]!.answer.text, 'Lunch is at noon.');
  } finally { await h.s.close(); }
});

test('speech: no glasses tags falls back to loudness', async () => {
  const h = speech(() => undefined);
  try {
    h.say('What time is lunch?', 0, 500);
    assert.deepEqual(h.utterances.map(u => u.role), ['wearer']); // loud, above -25 dB + margin
  } finally { await h.s.close(); }
});

test('speech: glasses "unknown" is never a question', async () => {
  const h = speech(() => 'unknown');
  try {
    h.say('What time is lunch?', 0, 500);
    assert.equal(h.questions.length, 0);
    assert.deepEqual(h.utterances.map(u => u.role), ['unknown']);
  } finally { await h.s.close(); }
});
