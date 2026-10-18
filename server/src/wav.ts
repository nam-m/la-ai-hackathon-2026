/** Wrap raw 16 kHz mono 16-bit PCM in a 44-byte WAV header. */
export function toWav(pcm: Buffer, sampleRate = 16_000) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

/** Rolling buffer of the last N seconds of PCM, addressed by milliseconds since the first byte. */
export class PcmRing {
  private chunks: { start: number; buf: Buffer }[] = [] // start = absolute byte offset
  private total = 0
  constructor(private maxBytes = 32_000 * 60) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes % 2) {
      throw new Error('PCM ring capacity must be a positive, sample-aligned byte count')
    }
  }

  push(buf: Buffer) {
    if (!buf.length) return
    const start = this.total
    this.total += buf.length
    // Preserve the absolute byte clock even when a single incoming chunk is
    // larger than the ring. Retain only complete source samples at the front.
    const cutoff = Math.max(0, Math.ceil((this.total - this.maxBytes) / 2) * 2)
    while (this.chunks.length && this.chunks[0].start + this.chunks[0].buf.length <= cutoff) this.chunks.shift()
    const first = this.chunks[0]
    if (first && first.start < cutoff) {
      first.buf = Buffer.from(first.buf.subarray(cutoff - first.start))
      first.start = cutoff
    }
    const skipped = Math.max(0, cutoff - start)
    // A copy prevents incoming frame reuse from rewriting tone audio, and
    // avoids retaining the backing allocation of an oversized frame.
    this.chunks.push({ start: start + skipped, buf: Buffer.from(buf.subarray(skipped)) })
  }

  /** Audio between startMs and endMs (from the first byte received), or null if it has already rolled off. */
  get(startMs: number, endMs: number): Uint8Array | null {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs || endMs > this.receivedMs) return null
    const toByte = (ms: number) => Math.floor(ms * 16) * 2 // 32 bytes per ms, sample-aligned (no 32-bit bit ops)
    const a = toByte(startMs), b = toByte(endMs)
    if (b <= a || !this.chunks.length || a < this.chunks[0].start) return null
    const parts: Buffer[] = []
    for (const c of this.chunks) {
      const cEnd = c.start + c.buf.length
      if (cEnd <= a || c.start >= b) continue
      parts.push(c.buf.subarray(Math.max(0, a - c.start), Math.min(c.buf.length, b - c.start)))
    }
    return new Uint8Array(Buffer.concat(parts))
  }

  get receivedMs() { return this.total / 32 }
}
