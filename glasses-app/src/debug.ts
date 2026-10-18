// Tools for B's loudness test: per-chunk level, the glasses' own speakerRole
// guess, and a fixed-length recording saved to the laptop for analysis.

const SAMPLE_RATE = 16_000
const BYTES_PER_SECOND = SAMPLE_RATE * 2
const SILENCE_DB = -90

/** Loudness of one s16le chunk in dBFS: 0 is full scale, -90 is silence. */
export function dbfs(pcm: Uint8Array): number {
  // Chunks can start at an odd byteOffset, which an Int16Array view can't, so read through a DataView.
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const samples = pcm.byteLength >> 1
  if (samples === 0) return SILENCE_DB
  let sum = 0
  for (let i = 0; i < samples; i++) {
    const s = view.getInt16(i * 2, true) / 32768
    sum += s * s
  }
  const rms = Math.sqrt(sum / samples)
  return rms > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(rms)) : SILENCE_DB
}

/** speakerRole tally over the last few chunks: who the glasses think is talking now. */
export class RoleWindow {
  private readonly roles: string[] = []

  constructor(private readonly size = 20) {}

  push(role: string) {
    this.roles.push(role)
    if (this.roles.length > this.size) this.roles.shift()
  }

  counts(): Record<string, number> {
    const counts: Record<string, number> = { self: 0, other: 0, unknown: 0 }
    for (const role of this.roles) counts[role] = (counts[role] ?? 0) + 1
    return counts
  }
}

export type FrameStat = { ms: number; db: number; role: string; direction: number | null }

/** A fixed-length capture of the glasses mic, with stats for every chunk. */
export class Recording {
  private readonly chunks: Uint8Array[] = []
  private readonly frames: FrameStat[] = []
  private bytes = 0
  private readonly startedAt = new Date()

  constructor(private readonly seconds: number) {}

  get progress(): number {
    return Math.min(1, this.bytes / (this.seconds * BYTES_PER_SECOND))
  }

  /** Adds one chunk; returns true once the recording is full. */
  push(pcm: Uint8Array, stat: Omit<FrameStat, 'ms'>): boolean {
    this.frames.push({ ms: Math.round((this.bytes / BYTES_PER_SECOND) * 1000), ...stat })
    this.chunks.push(pcm.slice())
    this.bytes += pcm.byteLength
    return this.progress >= 1
  }

  /**
   * Saves `<name>.wav` and `<name>.json` to dev/recordings/ through the Vite dev
   * server. Downloads inside the Even app WebView are unreliable, and the
   * laptop is where B analyzes them anyway.
   */
  async upload(): Promise<string> {
    const name = `g2-${this.startedAt.toISOString().replace(/[:.]/g, '-')}`
    const meta = {
      sampleRate: SAMPLE_RATE,
      seconds: this.seconds,
      startedAt: this.startedAt.toISOString(),
      frames: this.frames,
    }
    await post(`${name}.wav`, new Blob([this.toWav()], { type: 'audio/wav' }))
    await post(`${name}.json`, new Blob([JSON.stringify(meta, null, 1)], { type: 'application/json' }))
    return name
  }

  private toWav(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(44 + this.bytes)
    const view = new DataView(out.buffer)
    const ascii = (offset: number, text: string) => {
      for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i)
    }
    ascii(0, 'RIFF')
    view.setUint32(4, 36 + this.bytes, true)
    ascii(8, 'WAVE')
    ascii(12, 'fmt ')
    view.setUint32(16, 16, true) // fmt chunk size
    view.setUint16(20, 1, true) // PCM
    view.setUint16(22, 1, true) // mono
    view.setUint32(24, SAMPLE_RATE, true)
    view.setUint32(28, BYTES_PER_SECOND, true)
    view.setUint16(32, 2, true) // bytes per sample frame
    view.setUint16(34, 16, true) // bits per sample
    ascii(36, 'data')
    view.setUint32(40, this.bytes, true)
    let offset = 44
    for (const chunk of this.chunks) {
      out.set(chunk, offset)
      offset += chunk.byteLength
    }
    return out
  }
}

async function post(file: string, body: Blob) {
  const res = await fetch(`/dev/recordings/${file}`, { method: 'POST', body })
  if (!res.ok) throw new Error(`upload of ${file} failed: HTTP ${res.status}`)
}
