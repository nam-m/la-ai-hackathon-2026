import type { SpeakerRole } from './speech/index.js'

/** The glasses' own guess for an audio frame, as the Even SDK names it (AudioEvent.speakerRole). */
export type GlassesRole = 'self' | 'other' | 'unknown'

export const isGlassesRole = (v: unknown): v is GlassesRole => v === 'self' || v === 'other' || v === 'unknown'

const BYTES_PER_MS = 32 // 16 kHz, 16-bit mono
const KEEP_MS = 60_000 // same span as the session's PcmRing
// Share of an utterance's tagged audio one role needs before it decides; anything closer is unknown.
const MAJORITY = 0.6
// Below this share of tagged audio the tags say too little, and loudness decides instead.
const MIN_COVERAGE = 0.5

type Span = { startMs: number; endMs: number; role: GlassesRole | null }

/**
 * The phone sends a `role` message whenever the glasses' speakerRole changes, ahead of the audio it
 * applies to. This keeps those tags on the same clock as the session's audio (ms since its first
 * byte), so an utterance's role can be read back from its startMs/endMs.
 */
export class RoleTimeline {
  private spans: Span[] = []
  private bytes = 0
  private current: GlassesRole | null = null

  /** A `role` message: applies to the audio that follows. */
  set(role: GlassesRole) {
    this.current = role
  }

  /** Call for every audio frame the session keeps, in order. */
  addAudio(byteLength: number) {
    const startMs = this.bytes / BYTES_PER_MS
    this.bytes += byteLength
    const endMs = this.bytes / BYTES_PER_MS
    const last = this.spans[this.spans.length - 1]
    if (last && last.role === this.current && last.endMs === startMs) last.endMs = endMs
    else this.spans.push({ startMs, endMs, role: this.current })
    // Like the PcmRing, forget audio older than KEEP_MS, trimming a long run that started before it.
    const cutoff = endMs - KEEP_MS
    while (this.spans.length && this.spans[0].endMs <= cutoff) this.spans.shift()
    if (this.spans.length && this.spans[0].startMs < cutoff) this.spans[0].startMs = cutoff
  }

  /**
   * wearer when the glasses said "self" for most of the utterance, other when they said "other",
   * unknown when split or unsure. Undefined when the phone sent too few tags (an older app, or the
   * audio has rolled off), so loudness can decide.
   */
  roleAt(startMs: number, endMs: number): SpeakerRole | undefined {
    if (!(endMs > startMs)) return undefined
    const ms = { self: 0, other: 0, unknown: 0 }
    for (const s of this.spans) {
      const overlap = Math.min(s.endMs, endMs) - Math.max(s.startMs, startMs)
      if (overlap > 0 && s.role) ms[s.role] += overlap
    }
    const tagged = ms.self + ms.other + ms.unknown
    if (tagged < (endMs - startMs) * MIN_COVERAGE) return undefined
    if (ms.self >= tagged * MAJORITY) return 'wearer'
    if (ms.other >= tagged * MAJORITY) return 'other'
    return 'unknown'
  }
}
