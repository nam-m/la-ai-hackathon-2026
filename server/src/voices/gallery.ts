// The remembered voices and the matching rules, ported from the Speaker ID prototype (testapp/test1/server.py).
// Pure logic over unit-length voiceprints: the Python service only turns audio into vectors.
import type { NameEvidence, VoiceRecord } from '../types.js'
import type { Voiceprint } from './client.js'

export const VOICE = {
  STICKY: 0.05, // whoever is already speaking keeps the label down to threshold - STICKY
  MARGIN: 0.10, // this far below the threshold counts as clearly not that person
  ONE_VOICE: 0.50, // halves of one person's speech score above this (LibriSpeech: same >= 0.60, two people <= 0.32)
  MIN_SAME: 0.30, // a voice less like a named person than this is someone else with the same name
  REDUNDANT: 0.85, // a sample this close to the kept ones adds nothing
  STRONG: 0.05, // a match this far above the threshold may add a sample (0.10 never let G2 far-field audio teach anything)
  MIN_SAMPLE_SEC: 3, // speech needed for a new voice or a new sample
  MAX_SAMPLES: 10,
  MAX_UNNAMED: 20,
  UNNAMED_TTL_MS: 30 * 60_000, // an unnamed voice not heard for this long is forgotten
  WEARER_SAMPLES: 5,
}

export type Persist = { load(): VoiceRecord[]; save(v: VoiceRecord): void; remove(id: string): void }
export type Identification = {
  id: string | null
  score: number // best score over all voices
  scores: Record<string, number> // voice id -> score
  wearer: number // score against the wearer's own voice
  wearerLike: boolean // closer to the wearer than to anyone, and above the threshold: a mislabeled wearer line
}
export type NameResult = { ok: true; voice: VoiceRecord; merged: boolean } | { ok: false; reason: string }

const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }
/** A voice is several samples (calm, loud, ...); the closest one counts. */
const score = (emb: number[], samples: number[][]) => samples.reduce((best, s) => Math.max(best, dot(emb, s)), -1)
const round = (v: number[]) => v.map(x => Math.round(x * 1e5) / 1e5)
const round3 = (x: number) => Math.round(x * 1000) / 1000

export const label = (v: VoiceRecord) => v.name ?? `Voice ${v.seq}`

/** "kevin!" -> "Kevin"; null for something that isn't a plausible first name. */
export function cleanName(raw: string) {
  const name = raw.trim().replace(/[.,!?;:"“”]+/g, '').replace(/\s+/g, ' ')
  if (!name || name.length > 30 || !/^[\p{L}][\p{L}' -]*$/u.test(name)) return null
  return name.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ')
}

export class Gallery {
  threshold: number
  private voices = new Map<string, VoiceRecord>()
  private wearer: number[][] = [] // the wearer's own voice, in memory only, so mislabeled wearer lines are not taken for someone
  private aliases = new Map<string, string>() // merged voice id -> the voice it merged into
  private nextSeq = 1

  constructor(private persist: Persist, threshold: number) {
    this.threshold = threshold
    for (const v of persist.load()) {
      this.voices.set(v.id, v)
      this.nextSeq = Math.max(this.nextSeq, v.seq + 1)
    }
  }

  list() { this.prune(); return [...this.voices.values()] }
  /** A voice by id, following merges. */
  get(id: string): VoiceRecord | undefined {
    for (let i = 0; i < 5 && !this.voices.has(id) && this.aliases.has(id); i++) id = this.aliases.get(id)!
    return this.voices.get(id)
  }
  get wearerSamples() { return this.wearer.length }

  identify(emb: number[], currentId: string | null): Identification {
    const scores: Record<string, number> = {}
    let best: string | null = null
    for (const v of this.list()) {
      scores[v.id] = round3(score(emb, v.samples))
      if (best === null || scores[v.id] > scores[best]) best = v.id
    }
    const top = best === null ? 0 : scores[best]
    const wearer = this.wearer.length ? round3(score(emb, this.wearer)) : 0
    if (wearer >= this.threshold && wearer > top) return { id: null, score: top, scores, wearer, wearerLike: true }
    const bar = best === currentId ? this.threshold - VOICE.STICKY : this.threshold
    return { id: best !== null && top >= bar ? best : null, score: top, scores, wearer, wearerLike: false }
  }

  /** One clip, one voice: its halves must agree. */
  static oneVoice(print: Voiceprint) {
    return Boolean(print.first && print.second) && dot(print.first!, print.second!) >= VOICE.ONE_VOICE
  }

  /**
   * A new unnamed voice from an unrecognized clip, or why not: it needs 3 s of one voice that is clearly nobody
   * known (whole clip and both halves), so a known person sounding different doesn't become a duplicate.
   */
  createUnnamed(print: Voiceprint, now = new Date()): VoiceRecord | string {
    if (print.seconds < VOICE.MIN_SAMPLE_SEC || !print.first || !print.second) return `only ${print.seconds}s of speech`
    if (!Gallery.oneVoice(print)) return 'two voices in the clip'
    const known = [...this.list().map(v => v.samples), this.wearer].filter(s => s.length)
    if ([print.whole, print.first, print.second].some(e => known.some(s => score(e, s) >= this.threshold - VOICE.MARGIN)))
      return 'partly like a known voice'
    this.pruneUnnamed(VOICE.MAX_UNNAMED - 1)
    const at = now.toISOString()
    const v: VoiceRecord = { id: `voice_${now.getTime().toString(36)}${this.nextSeq}`, seq: this.nextSeq++, name: null, samples: [round(print.whole)], createdAt: at, lastSeenAt: at, heard: 1 }
    this.voices.set(v.id, v)
    return v
  }

  /** A recognized utterance: count it, and keep a strong, new-sounding 3 s clip as another sample. */
  heard(id: string, print: Voiceprint, matchScore: number, now = new Date()) {
    const v = this.voices.get(id)
    if (!v) return false
    v.heard++
    v.lastSeenAt = now.toISOString()
    const own = score(print.whole, v.samples)
    const learn = v.samples.length < VOICE.MAX_SAMPLES && matchScore >= this.threshold + VOICE.STRONG && own < VOICE.REDUNDANT
      && print.seconds >= VOICE.MIN_SAMPLE_SEC && Gallery.oneVoice(print)
    if (learn) v.samples.push(round(print.whole))
    if (v.name) this.persist.save(v)
    return learn
  }

  /** The wearer's own voice, from clear wearer lines; ignored once there are enough different samples. */
  addWearer(emb: number[]) {
    if (this.wearer.length >= VOICE.WEARER_SAMPLES || (this.wearer.length && score(emb, this.wearer) >= VOICE.REDUNDANT)) return false
    this.wearer.push(round(emb))
    return true
  }

  /**
   * Name a voice; a named voice is saved. A voice that already has another name keeps it unless the name was typed
   * on the dashboard. Two voices given the same name merge when they sound alike, otherwise the new one is refused:
   * a wrong name on the glasses is worse than none.
   */
  assignName(id: string, rawName: string, evidence: NameEvidence): NameResult {
    const v = this.voices.get(id)
    const name = cleanName(rawName)
    if (!v) return { ok: false, reason: 'voice is gone' }
    if (!name) return { ok: false, reason: `"${rawName}" is not a name` }
    const manual = evidence.kind === 'manual'
    if (v.name && v.name !== name && !manual) return { ok: false, reason: `already named ${v.name}` }
    const twin = this.list().find(x => x.id !== id && x.name?.toLowerCase() === name.toLowerCase())
    if (twin) {
      const like = Math.max(...v.samples.map(s => score(s, twin.samples)))
      if (like < VOICE.MIN_SAME && !manual) return { ok: false, reason: `doesn't sound like the ${name} we know (${round3(like)})` }
      twin.samples = [...twin.samples, ...v.samples]
      if (twin.samples.length > VOICE.MAX_SAMPLES) twin.samples = [twin.samples[0], ...twin.samples.slice(-(VOICE.MAX_SAMPLES - 1))]
      twin.heard += v.heard
      twin.lastSeenAt = v.lastSeenAt > twin.lastSeenAt ? v.lastSeenAt : twin.lastSeenAt
      this.remove(id)
      this.aliases.set(id, twin.id)
      this.persist.save(twin)
      return { ok: true, voice: twin, merged: true }
    }
    v.name = name
    v.evidence = evidence
    this.persist.save(v)
    return { ok: true, voice: v, merged: false }
  }

  remove(id: string) {
    const v = this.voices.get(id)
    if (!v) return false
    this.voices.delete(id)
    if (v.name) this.persist.remove(id)
    return true
  }

  forgetWearer() { this.wearer = [] }

  private prune(now = Date.now()) {
    for (const v of this.voices.values()) if (!v.name && now - Date.parse(v.lastSeenAt) > VOICE.UNNAMED_TTL_MS) this.voices.delete(v.id)
  }

  /** Keep at most `max` unnamed voices: the least recently heard go first. */
  private pruneUnnamed(max: number) {
    const unnamed = [...this.voices.values()].filter(v => !v.name).sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt))
    for (const v of unnamed.slice(0, Math.max(0, unnamed.length - max))) this.voices.delete(v.id)
  }
}
