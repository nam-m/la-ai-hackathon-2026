import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PcmRing, toWav } from '../src/wav.js'
import { AudioPipeline } from '../src/speech/audio.js'
import { readPcmWav } from '../src/speech/calibration.js'

function pcm(ms: number, amplitude = 0): Buffer {
  const bytes = Buffer.alloc(ms * 32)
  for (let offset = 0; offset < bytes.length; offset += 2) bytes.writeInt16LE(amplitude, offset)
  return bytes
}

test('PCM ring rejects invalid and partially unavailable ranges without truncation', () => {
  const ring = new PcmRing()
  assert.equal(ring.get(0, 1), null)
  ring.push(pcm(100, 1234))
  for (const [start, end] of [[NaN, 50], [0, Infinity], [-1, 50], [50, 20], [0, 0], [0, 101], [90, 101], [100, 101], [0, 100.001]]) {
    assert.equal(ring.get(start!, end!), null, `${start}..${end}`)
  }
  assert.equal(ring.get(0, 100)?.length, 3200)
  assert.equal(ring.get(0, .01), null)
})

test('PCM ring copies source frames and returned clips and spans chunk boundaries', () => {
  const ring = new PcmRing()
  const first = pcm(50, 3000)
  const second = pcm(50, -4000)
  ring.push(first)
  ring.push(second)
  first.fill(0)
  second.fill(0)
  const expected = Buffer.concat([pcm(25, 3000), pcm(25, -4000)])
  const clip = ring.get(25, 75)!
  assert.deepEqual(Buffer.from(clip), expected)
  clip.fill(0)
  assert.deepEqual(Buffer.from(ring.get(25, 75)!), expected)
  assert.equal(ring.receivedMs, 100)
})

test('PCM ring retains exactly the last 60 seconds including a single oversized frame', () => {
  const ring = new PcmRing()
  ring.push(pcm(62_000, 1000))
  assert.equal(ring.receivedMs, 62_000)
  assert.equal(ring.get(0, 62_000), null)
  assert.equal(ring.get(1999, 2001), null)
  assert.equal(ring.get(2000, 62_000)?.length, 32_000 * 60)
  ring.push(pcm(100, -2000))
  assert.equal(ring.get(2000, 2200), null)
  assert.equal(ring.get(2100, 62_100)?.length, 32_000 * 60)
  assert.deepEqual(Buffer.from(ring.get(62_000, 62_100)!), pcm(100, -2000))
})

test('PCM ring prunes partial chunks at the exact boundary and accepts odd chunk boundaries', () => {
  const ring = new PcmRing(3200)
  const source = Buffer.concat([pcm(50, 1000), pcm(100, 2000)])
  ring.push(source.subarray(0, 301))
  ring.push(source.subarray(301, 2003))
  ring.push(source.subarray(2003))
  assert.equal(ring.receivedMs, 150)
  assert.equal(ring.get(49, 51), null)
  assert.deepEqual(Buffer.from(ring.get(50, 150)!), pcm(100, 2000))
  ring.push(Buffer.alloc(0))
  assert.equal(ring.receivedMs, 150)
  for (const capacity of [0, -2, 3, NaN, Infinity]) assert.throws(() => new PcmRing(capacity), /capacity/)
})

test('silence omitted from provider audio remains in the ring source byte timeline', () => {
  const ring = new PcmRing()
  const pipeline = new AudioPipeline({ onFrame() {}, hangoverMs: 0 })
  const push = (bytes: Buffer) => { ring.push(bytes); pipeline.push(bytes) }
  push(pcm(100, 5000))
  push(pcm(3000))
  push(pcm(100, 7000))
  assert.equal(ring.receivedMs, pipeline.receivedMs)
  const range = pipeline.mapRange(200, 300)!
  assert.equal(range.startMs, 3100)
  assert.equal(range.endMs, 3200)
  assert.deepEqual(Buffer.from(ring.get(range.startMs, range.endMs)!), pcm(100, 7000))
  assert.deepEqual(Buffer.from(ring.get(100, 3100)!), pcm(3000))
})

test('WAV packaging preserves original PCM bytes and silence', () => {
  const source = Buffer.concat([pcm(100), pcm(100, -3000), pcm(100)])
  assert.deepEqual(Buffer.from(readPcmWav(toWav(source))), source)
})
