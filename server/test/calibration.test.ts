import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calibrateSpeech, readPcmWav } from '../src/speech/calibration.js';

function pcm(value: number): Uint8Array {
  const bytes = new Uint8Array(3200);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < bytes.length; i += 2) view.setInt16(i, value, true);
  return bytes;
}

function wav(): Buffer {
  const data = Buffer.from(pcm(2000));
  const bytes = Buffer.alloc(44 + data.length);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(data.length, 40); data.copy(bytes, 44);
  return bytes;
}

test('strict WAV parser returns PCM and rejects invalid formats and truncation', () => {
  assert.deepEqual(readPcmWav(wav()), pcm(2000));
  for (const [offset, value] of [[20, 3], [22, 2], [24, 48000], [28, 1], [32, 4], [34, 24]] as const) {
    const bytes = wav();
    bytes.writeUInt16LE(value, offset);
    assert.throws(() => readPcmWav(bytes), /16-bit/);
  }
  assert.throws(() => readPcmWav(wav().subarray(0, 50)), /size/);
  assert.throws(() => readPcmWav(pcm(100)), /RIFF/);
});

test('clear conservative gap recommends ElevenLabs with an interior threshold', () => {
  const result = calibrateSpeech([{ label: 'wearer', pcm: pcm(8000) }, { label: 'wearer', pcm: pcm(10000) }, { label: 'other', pcm: pcm(2000) }]);
  assert.equal(result.recommendedProvider, 'elevenlabs');
  assert.equal(result.clearGap, true);
  assert.ok(result.thresholdDb! > result.distributions.other.max);
  assert.ok(result.thresholdDb! < result.distributions.wearer.min);
  assert.equal(result.distributions.wearer.count, 2);
  assert.deepEqual(result.providerOptions, { provider: 'elevenlabs', wearerThresholdDb: result.thresholdDb });
});

test('overlap or a gap below 6 dB recommends Deepgram without a threshold', () => {
  for (const wearer of [1000, 2000, 3000]) {
    const result = calibrateSpeech([{ label: 'wearer', pcm: pcm(wearer) }, { label: 'other', pcm: pcm(2000) }]);
    assert.equal(result.recommendedProvider, 'deepgram');
    assert.equal(result.thresholdDb, null);
    assert.deepEqual(result.providerOptions, { provider: 'deepgram' });
  }
  assert.equal(calibrateSpeech([{ label: 'wearer', pcm: pcm(4000) }, { label: 'other', pcm: pcm(2000) }]).clearGap, true);
});

test('missing classes, silence, and incomplete PCM fail calibration', () => {
  assert.throws(() => calibrateSpeech([{ label: 'wearer', pcm: pcm(2000) }]), /wearer and other/);
  assert.throws(() => calibrateSpeech([{ label: 'wearer', pcm: pcm(0) }]), /audible/);
  assert.throws(() => calibrateSpeech([{ label: 'wearer', pcm: new Uint8Array(3) }]), /complete/);
});
