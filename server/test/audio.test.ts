import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AudioPipeline, pcmRmsDb } from '../src/speech/audio.js';

function pcm(ms: number, value = 0): Uint8Array {
  const bytes = new Uint8Array(ms * 32);
  const view = new DataView(bytes.buffer);
  for (let offset = 0; offset < bytes.length; offset += 2) view.setInt16(offset, value, true);
  return bytes;
}

test('RMS reads signed LE samples and produces a finite silence floor', () => {
  assert.equal(pcmRmsDb(pcm(50)), -120);
  assert.ok(Math.abs(pcmRmsDb(pcm(50, -16384)) + 6.0206) < .001);
  assert.equal(pcmRmsDb(new Uint8Array()), -120);
});

test('odd byte chunks reconstruct identical audio with correct input clock', () => {
  const frames: Uint8Array[] = [];
  const pipeline = new AudioPipeline({ onFrame: frame => frames.push(frame) });
  const input = pcm(100, 2000);
  for (let index = 0; index < input.length; index += 7) pipeline.push(input.subarray(index, index + 7));
  assert.equal(frames.length, 2);
  assert.equal(pipeline.receivedMs, 100);
  assert.deepEqual(Buffer.concat(frames), Buffer.from(input));
});

test('initial silence is withheld, preroll and full VAD trailing hangover are forwarded', () => {
  const frames: Uint8Array[] = [];
  const pipeline = new AudioPipeline({ onFrame: frame => frames.push(frame), startMs: 500 });
  pipeline.push(pcm(1000));
  assert.equal(frames.length, 0);
  pipeline.push(pcm(100, 3000));
  assert.equal(frames.length, 4);
  pipeline.push(pcm(2500));
  assert.equal(frames.length, 44);
  assert.equal(pipeline.receivedMs, 3600);
  assert.deepEqual(pipeline.mapRange(100, 200), { startMs: 1500, endMs: 1600, rmsDb: pcmRmsDb(pcm(100, 3000)) });
  assert.equal(pipeline.mapRange(0, 100)?.rmsDb, -120);
});

test('provider ranges preserve source gaps and compute energy from original samples', () => {
  const pipeline = new AudioPipeline({ onFrame: () => {}, hangoverMs: 0 });
  pipeline.push(pcm(50, 4096));
  pipeline.push(pcm(1000));
  pipeline.push(pcm(50, 8192));
  const range = pipeline.mapRange(0, 200)!;
  assert.equal(range.startMs, 0);
  assert.equal(range.endMs, 1100);
  const expected = 10 * Math.log10((4096 ** 2 + 8192 ** 2) / 4 / 32768 ** 2);
  assert.ok(Math.abs(range.rmsDb - expected) < 1e-8);
  assert.equal(pipeline.mapRange(0, 201), null);
  assert.equal(pipeline.mapRange(-1, 50), null);
});

test('retention refuses partially evicted intervals; flush and reset maintain clocks', () => {
  const pipeline = new AudioPipeline({ onFrame: () => {} });
  pipeline.push(pcm(120_100, 3000));
  assert.equal(pipeline.mapRange(0, 200), null);
  assert.equal(pipeline.mapRange(100, 200)?.startMs, 100);
  pipeline.reset();
  pipeline.push(pcm(23, 3000));
  assert.equal(pipeline.mapRange(0, 23), null);
  pipeline.flush();
  assert.equal(pipeline.receivedMs, 23);
  assert.equal(pipeline.mapRange(0, 23)?.endMs, 23);
});
