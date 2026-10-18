import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeRecording, pcmToWav } from '../src/speech/recording.js';
import { readPcmWav } from '../src/speech/calibration.js';

function pcm(ms: number, value = 0): Uint8Array {
  const bytes = new Uint8Array(ms * 32);
  const view = new DataView(bytes.buffer);
  for (let offset = 0; offset < bytes.length; offset += 2) view.setInt16(offset, value, true);
  return bytes;
}

function join(...parts: Uint8Array[]): Uint8Array { return Uint8Array.from(Buffer.concat(parts)); }

test('decodeRecording accepts canonical raw PCM and preserves its bytes', () => {
  const original = pcm(100, -3000);
  assert.deepEqual(Uint8Array.from(decodeRecording(Buffer.from(original).toString('base64'))), original);
  assert.equal(decodeRecording('AAA=').length, 2);
});

test('decodeRecording rejects malformed, noncanonical, empty, and incomplete samples', () => {
  for (const malformed of ['', 'AAA', 'AAA=\n', 'AA A=', 'AA-A', 'AA_A', '====', 'AA=A', 'A===', 'AAB=', 'data:audio/pcm;base64,AAA=']) {
    assert.throws(() => decodeRecording(malformed), /base64/);
  }
  assert.throws(() => decodeRecording('AA=='), /complete/);
  assert.throws(() => decodeRecording('AAAA'), /complete/);
});

test('decodeRecording bounds encoded and decoded size and validates duration', () => {
  const encoded = Buffer.from(pcm(20)).toString('base64');
  assert.equal(decodeRecording(encoded, 20).length, 640);
  assert.throws(() => decodeRecording(encoded, 19), /maximum duration/);
  // Both two and three decoded bytes occupy four base64 characters.
  assert.throws(() => decodeRecording('AAAA', 2 / 32), /maximum duration/);
  for (const duration of [0, -1, Infinity, NaN]) assert.throws(() => decodeRecording(encoded, duration), /duration/);
  assert.throws(() => decodeRecording('A'.repeat(200_000), 10), /maximum duration/);
});

test('pcmToWav produces strict 16kHz mono signed16 WAV and preserves all pauses', () => {
  const original = join(pcm(100), pcm(200, -6000), pcm(120));
  const wav = pcmToWav(original);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.deepEqual(readPcmWav(wav), original);
  assert.throws(() => pcmToWav(new Uint8Array(3)), /complete/);
  assert.throws(() => pcmToWav(new Uint8Array()), /nonempty/);
});
