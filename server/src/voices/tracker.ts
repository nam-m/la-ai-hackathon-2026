// Per-session voice recognition: who is talking to the wearer, and the names heard in conversation.
// Runs beside matching and never delays it; everything it does is logged for the voice dashboard.
import { config } from '../config.js'
import * as store from '../store.js'
import type { Utterance } from '../speech/index.js'
import type { ServerMessage } from '../types.js'
import type { EmbedResult } from './client.js'
import { Gallery, VOICE, cleanName, label } from './gallery.js'
import { MIN_CONFIDENCE, isWhoAreYou, mightHaveName, whoIsName, type NameFinding, type NameLine } from './names.js'

const ABOUT_MAX_CHARS = 100 // fits the glasses' two lines

/** The turn's words as one "about me", whole sentences only, or null when it says no more than the name. */
function aboutText(texts: string[], name: string) {
  let out = ''
  for (const sentence of texts.join(' ').split(/(?<=[.!?])\s+/)) {
    const next = out ? `${out} ${sentence}` : sentence
    if (next.length > ABOUT_MAX_CHARS) break
    out = next
  }
  return out.length > name.length + 12 ? out : null
}

const TURN_GAP_MS = 1500 // other-lines closer than this (with no wearer line between) are one person's turn
const TURN_WINDOW_MS = 6000 // newest audio of the turn used per check
const PAD_MS = 300 // speech timestamps hug the words; a little either side gives the short lines more voice
const RECENT_MS = 30_000 // the person who just talked to the wearer stays the likely one across the wearer's replies
// The glasses' own role tags are often wrong for a visitor close by (live test: Kevin's lines came back "self"
// or "unknown"). Those lines are still checked against known voices; a "self" line needs this much more to count.
const MISLABELED_EXTRA = 0.15
const MIN_CLIP_MS = 700
const SHORT_SEC = 1.0 // under this much speech, only a strong match counts and no new voice is made
const WEARER_MIN_MS = 1500 // wearer lines at least this long teach the wearer's own voice
const ADDRESSED_BEFORE_MS = 10_000 // "Thanks, Sarah": the other turn that ended this recently is Sarah
const ADDRESSED_AFTER_MS = 15_000 // "Hi Tom!": otherwise the next other turn starting this soon is Tom
const SPEAKER_REPEAT_MS = 3000 // the same name goes to the glasses at most this often
const CONTEXT_LINES = 6

export type VoiceEventKind = 'heard' | 'shown' | 'unknown' | 'new_voice' | 'learned' | 'wearer' | 'wearer_like' | 'too_short'
  | 'no_name' | 'name_found' | 'named' | 'rejected' | 'name_lost' | 'error'
export type VoiceEvent = {
  at: string
  session: string
  kind: VoiceEventKind
  text?: string
  voiceId?: string | null
  voice?: string | null // label at the time
  score?: number
  scores?: Record<string, number>
  wearer?: number
  seconds?: number
  ms?: number
  detail?: string
}

const events: VoiceEvent[] = []
export const voiceEvents = () => events
function logEvent(e: VoiceEvent) {
  events.push(e)
  if (events.length > 300) events.shift()
  const score = e.score === undefined ? '' : ` ${e.score.toFixed(2)}`
  console.log(`[voice ${e.session}] ${e.kind}${e.voice ? ` ${e.voice}` : ''}${score}${e.detail ? ` (${e.detail})` : ''}${e.text ? `: ${e.text}` : ''}`)
}

let shared: Gallery | null = null
/** The voices every session shares (they are people, not connections). Created on first use, after the store loads. */
export function gallery() {
  return (shared ??= new Gallery({
    load: () => store.listVoices().map(v => structuredClone(v)),
    save: v => store.saveVoice(structuredClone(v)),
    remove: id => store.deleteVoice(id),
  }, config.voiceThreshold))
}

export type TrackerDeps = {
  session: () => string
  embed: (pcm: Uint8Array) => Promise<EmbedResult>
  extractName: (lines: NameLine[]) => Promise<NameFinding | null>
  /** Audio on the utterance clock, or null if it has rolled off. */
  clip: (startMs: number, endMs: number) => Uint8Array | null
  send: (msg: ServerMessage) => boolean | void
  gallery?: Gallery
}

type PendingName = { finding: NameFinding; text: string }
type Turn = {
  startMs: number
  endMs: number
  voiceId: string | null
  pendingName?: PendingName
  queue: Promise<unknown>
  /** Waiting for this turn's voice to have a name (answers saved before the voice was known). */
  callbacks: ((name: string) => void)[]
  texts: string[] // what was said in the turn, for "about me"
  describes?: string // voice whose "about me" this turn is (they gave their name in it)
}

export const trackers = new Set<VoiceTracker>()

export class VoiceTracker {
  private turn: Turn | null = null
  private lastTurn: Turn | null = null
  private addressed: (PendingName & { untilMs: number }) | null = null
  /** "I'm Kevin." said first, too short to check: the next unnamed voice heard within 30 s is Kevin. */
  private orphanName: (PendingName & { untilMs: number }) | null = null
  private current: string | null = null // voice of the ongoing turn: it keeps the label down to threshold - STICKY
  private recent: { voiceId: string; atMs: number } | null = null // last recognized voice, on the utterance clock
  private results = new Map<string, { turn: Turn; job: Promise<string | null> }>() // utterance id -> its voice check
  private context: { role: NameLine['role']; text: string; turn: Turn | null }[] = []
  private lastSpeaker = { name: '', at: 0 }
  private learningWearer = false
  private namedCallbacks = new Map<string, ((name: string) => void)[]>() // voice id -> waiting for its name
  /** The newest check, for the dashboard. */
  live: { at: string; voiceId: string | null; voice: string | null; score: number; scores: Record<string, number>; wearer: number } | null = null

  constructor(private deps: TrackerDeps) { trackers.add(this) }

  get session() { return this.deps.session() }
  private get gallery() { return this.deps.gallery ?? gallery() }
  private label(id: string | null) { const v = id ? this.gallery.get(id) : undefined; return v ? label(v) : null }
  private log(e: Omit<VoiceEvent, 'at' | 'session'>) { logEvent({ at: new Date().toISOString(), session: this.session, ...e }) }

  onUtterance(u: Utterance, transcriptId: string) {
    if (u.role === 'wearer') {
      this.endTurn()
      void this.checkTagged(u, 'wearer')
    } else if (u.role === 'other') {
      this.onOther(u, transcriptId)
    } else {
      void this.checkTagged(u, 'unknown')
    }
    this.context.push({ role: u.role, text: u.text, turn: u.role === 'other' ? this.turn : null })
    if (this.context.length > CONTEXT_LINES) this.context.shift()
    void this.findName(u, u.role === 'other' ? this.turn : null)
  }

  /**
   * Whoever said this utterance, once their voice is checked (waits up to timeoutMs). A line too short to check
   * on its own ("At noon.") takes the voice of its turn, from the person's next lines.
   */
  async voiceFor(utteranceId: string, timeoutMs: number): Promise<{ id: string; name: string | null } | null> {
    const entry = this.results.get(utteranceId)
    if (!entry) return null
    const find = async () => (await entry.job) ?? (await entry.turn.queue, entry.turn.voiceId)
    const voiceId = await Promise.race([find(), new Promise<null>(done => setTimeout(() => done(null), timeoutMs).unref())])
    const v = voiceId ? this.gallery.get(voiceId) : undefined
    return v ? { id: v.id, name: v.name } : null
  }

  /** Call back once whoever said this utterance has a name in this session, e.g. to name an answer saved before it. */
  whenNamed(utteranceId: string, callback: (name: string) => void) {
    const turn = this.results.get(utteranceId)?.turn
    if (!turn) return
    if (turn.voiceId) this.onNamed(turn.voiceId, callback)
    else if (turn.callbacks.length < 20) turn.callbacks.push(callback)
  }

  private onNamed(voiceId: string, callback: (name: string) => void) {
    const name = this.gallery.get(voiceId)?.name
    if (name) return callback(name)
    const list = this.namedCallbacks.get(voiceId) ?? []
    if (list.length < 20) list.push(callback)
    this.namedCallbacks.set(voiceId, list)
  }

  snapshot() {
    const t = this.turn
    return {
      session: this.session,
      live: this.live,
      turn: t ? { voice: this.label(t.voiceId), seconds: +((t.endMs - t.startMs) / 1000).toFixed(1), pendingName: t.pendingName?.finding.name ?? null } : null,
      waitingForName: this.addressed?.finding.name ?? null,
    }
  }

  close() { trackers.delete(this) }

  private describe(turn: Turn, voiceId: string) {
    const v = this.gallery.get(voiceId)
    if (!v?.name || (v.about && turn.describes !== voiceId)) return // the first introduction is kept
    turn.describes = voiceId
    const about = aboutText(turn.texts, v.name)
    if (about) this.gallery.setAbout(voiceId, about, new Date().toISOString())
  }

  /**
   * "Who are you?" -> whoever talked to the wearer in the last 30 s, if remembered; "Who is Kevin?" -> what Kevin
   * said about himself. undefined = not such a question (or nothing known for "Who is X?": the matcher may know).
   */
  answerWho(text: string, atMs: number): { name: string; text: string; at: string } | null | undefined {
    const asked = whoIsName(text)
    if (asked) {
      const v = this.gallery.byName(asked)
      return v?.about ? { name: v.name!, text: v.about.text, at: v.about.at } : undefined
    }
    if (!isWhoAreYou(text)) return undefined
    const v = this.recent && atMs - this.recent.atMs < RECENT_MS ? this.gallery.get(this.recent.voiceId) : undefined
    if (!v?.name) return null
    return { name: v.name, text: v.about?.text ?? `This is ${v.name}.`, at: v.about?.at ?? v.lastSeenAt }
  }

  private onOther(u: Utterance, transcriptId: string) {
    if (!this.turn || u.startMs - this.turn.endMs > TURN_GAP_MS) this.startTurn(u)
    const turn = this.turn!
    turn.endMs = Math.max(turn.endMs, u.endMs)
    turn.texts.push(u.text)
    // They gave their name earlier in this turn: what follows belongs to their "about me" too.
    if (turn.describes) this.describe(turn, turn.describes)
    const job = turn.queue.then(() => this.identify(turn, u, transcriptId))
    turn.queue = job.catch(() => undefined)
    this.results.set(u.id, { turn, job: job.catch(() => null) })
    if (this.results.size > 100) this.results.delete(this.results.keys().next().value!)
  }

  private startTurn(u: Utterance) {
    this.endTurn()
    this.turn = { startMs: u.startMs, endMs: u.endMs, voiceId: null, queue: Promise.resolve(), callbacks: [], texts: [] }
    if (this.addressed && u.startMs <= this.addressed.untilMs) this.turn.pendingName = this.addressed
    this.addressed = null
  }

  private endTurn() {
    const turn = this.turn
    if (!turn) return
    this.lastTurn = turn
    this.turn = null
    this.current = null // a pause or the wearer ends the turn: the next voice must clear the full threshold
    void turn.queue.then(() => this.settleName(turn))
  }

  /** The voice that talked to the wearer within 30 s of this moment, if any. */
  private recentVoice(atMs: number) {
    return this.recent && Math.abs(atMs - this.recent.atMs) < RECENT_MS ? this.gallery.get(this.recent.voiceId) : undefined
  }

  /**
   * A turn is over and still holds a name it couldn't place ("I'm Kevin." is too short to check by voice):
   * it goes to the voice heard just before, if there is one; otherwise it is lost.
   */
  private settleName(turn: Turn) {
    const pending = turn.pendingName
    if (!pending || turn.voiceId) return
    turn.pendingName = undefined
    const v = this.recentVoice(turn.startMs)
    if (!v && pending.finding.kind !== 'addressed_by_wearer') {
      this.orphanName = { ...pending, untilMs: turn.endMs + RECENT_MS }
      return this.log({ kind: 'name_found', text: pending.text, detail: `${pending.finding.name}: line too short to check; the next unnamed voice in 30 s gets it` })
    }
    if (!v) return this.log({ kind: 'name_lost', text: pending.text, detail: `${pending.finding.name}: not enough of their voice to remember` })
    turn.voiceId = v.id
    this.log({ kind: 'name_found', text: pending.text, voiceId: v.id, voice: label(v), detail: `${pending.finding.name}: their line was too short to check, so it goes to the voice heard just before` })
    this.applyName(turn, pending)
  }

  private async identify(turn: Turn, u: Utterance, transcriptId: string): Promise<string | null> {
    const clip = this.deps.clip(Math.max(turn.startMs, u.endMs - TURN_WINDOW_MS) - PAD_MS, u.endMs + PAD_MS)
    if (!clip || clip.byteLength < MIN_CLIP_MS * 32) {
      this.log({ kind: 'too_short', text: u.text, seconds: +((clip?.byteLength ?? 0) / 32_000).toFixed(1) })
      return null
    }
    const r = await this.deps.embed(clip)
    if (!r.ok) {
      if (r.reason === 'too_short') this.log({ kind: 'too_short', text: u.text, detail: 'under 0.6 s of speech' })
      else if (r.reason !== 'off') this.log({ kind: 'error', text: u.text, detail: r.error ?? r.reason })
      return null
    }
    const g = this.gallery
    // In a conversation the wearer and one visitor take turns: whoever talked within 30 s keeps the lower bar
    // through the wearer's replies, and a short line from them needs only the normal bar.
    const recent = this.recent && u.startMs - this.recent.atMs < RECENT_MS ? this.gallery.get(this.recent.voiceId)?.id ?? null : null
    const id = g.identify(r.print.whole, this.current ?? recent)
    const short = r.print.seconds < SHORT_SEC
    if (short && id.id && id.score < g.threshold + (id.id === recent ? 0 : VOICE.STRONG)) id.id = null
    const base = { text: u.text, score: id.score, scores: id.scores, wearer: id.wearer, seconds: r.print.seconds, ms: r.print.ms }
    this.live = { at: new Date().toISOString(), voiceId: id.id, voice: this.label(id.id), score: id.score, scores: id.scores, wearer: id.wearer }
    if (id.wearerLike) {
      this.log({ kind: 'wearer_like', ...base, detail: 'sounds like the wearer; ignored' })
      return null
    }
    let voiceId = id.id
    if (voiceId) {
      const learned = g.heard(voiceId, r.print, id.score)
      this.log({ kind: learned ? 'learned' : 'heard', voiceId, voice: this.label(voiceId), ...base, detail: learned ? 'kept as another sample' : undefined })
    } else if (short) {
      this.log({ kind: 'unknown', ...base, detail: 'short clip: needs a strong match' })
    } else {
      const created = g.createUnnamed(r.print)
      if (typeof created === 'string') {
        this.log({ kind: 'unknown', ...base, detail: `not remembered: ${created}` })
      } else {
        voiceId = created.id
        this.log({ kind: 'new_voice', voiceId, voice: label(created), ...base })
      }
    }
    if (!voiceId) return null
    this.current = voiceId
    this.recent = { voiceId, atMs: u.endMs }
    turn.voiceId = voiceId
    if (this.orphanName && !turn.pendingName) {
      const orphan = this.orphanName
      if (u.startMs > orphan.untilMs) this.orphanName = null
      else if (!g.get(voiceId)?.name) {
        this.orphanName = null
        turn.pendingName = orphan
      }
    }
    for (const callback of turn.callbacks.splice(0)) this.onNamed(voiceId, callback)
    if (turn.pendingName) {
      const pending = turn.pendingName
      turn.pendingName = undefined
      this.applyName(turn, pending)
    }
    const v = g.get(turn.voiceId!)
    if (!v) return null
    this.live = { ...this.live, voiceId: v.id, voice: label(v) }
    store.updateTranscript(transcriptId, { voiceId: v.id, ...(v.name ? { name: v.name } : {}) })
    if (v.name) this.announce(v.name, id.score)
    return v.id
  }

  private announce(name: string, score: number) {
    const now = Date.now()
    if (name === this.lastSpeaker.name && now - this.lastSpeaker.at < SPEAKER_REPEAT_MS) return
    this.lastSpeaker = { name, at: now }
    const sent = this.deps.send({ v: 1, type: 'speaker', name, score })
    this.log({ kind: 'shown', voice: name, score, detail: sent === false ? 'NOT sent: glasses not connected or paused' : 'sent to the glasses' })
  }

  /**
   * A line the glasses tagged as the wearer's or as unsure: if it is clearly a remembered visitor, show their name
   * (a wearer-tagged line needs a stronger match). Otherwise a clear wearer line may teach the wearer's own voice,
   * but only when it sounds like nobody known, so a mislabeled visitor never becomes "the wearer".
   */
  private async checkTagged(u: Utterance, role: 'wearer' | 'unknown') {
    const clip = this.deps.clip(u.startMs - PAD_MS, u.endMs + PAD_MS)
    if (!clip || clip.byteLength < MIN_CLIP_MS * 32) return
    const r = await this.deps.embed(clip)
    if (!r.ok) return
    const g = this.gallery
    const recent = this.recent && u.startMs - this.recent.atMs < RECENT_MS ? g.get(this.recent.voiceId)?.id ?? null : null
    const id = g.identify(r.print.whole, recent)
    const v = id.id ? g.get(id.id) : undefined
    const bar = g.threshold + (role === 'wearer' ? MISLABELED_EXTRA : 0) + (r.print.seconds < SHORT_SEC ? VOICE.STRONG : 0)
    if (v && id.score >= bar && !id.wearerLike) {
      this.recent = { voiceId: v.id, atMs: u.endMs }
      this.live = { at: new Date().toISOString(), voiceId: v.id, voice: label(v), score: id.score, scores: id.scores, wearer: id.wearer }
      this.log({ kind: 'heard', voiceId: v.id, voice: label(v), text: u.text, score: id.score, scores: id.scores, seconds: r.print.seconds, ms: r.print.ms, detail: `tagged "${role === 'wearer' ? 'self' : 'unknown'}" by the glasses` })
      if (v.name) this.announce(v.name, id.score)
      return
    }
    if (role !== 'wearer' || this.learningWearer || g.wearerSamples >= 5 || r.print.seconds < WEARER_MIN_MS / 1000) return
    if (id.score >= g.threshold - VOICE.MARGIN) return // could be a visitor: never learn the wearer from it
    this.learningWearer = true
    try {
      if (g.addWearer(r.print.whole)) this.log({ kind: 'wearer', text: u.text, score: id.score, seconds: r.print.seconds, detail: `wearer voice sample ${g.wearerSamples}/5` })
    } finally {
      this.learningWearer = false
    }
  }

  private async findName(u: Utterance, turn: Turn | null) {
    const lines: NameLine[] = this.context.map(c => ({ role: c.role, text: c.text, voice: this.label(c.turn?.voiceId ?? null) }))
    if (!mightHaveName(lines)) return
    let finding: NameFinding | null
    try {
      finding = await this.deps.extractName(lines)
    } catch (e) {
      return this.log({ kind: 'error', text: u.text, detail: `name check failed: ${(e as Error).message}` })
    }
    if (!finding) return this.log({ kind: 'no_name', text: u.text, detail: 'checked for a name: none' })
    const pending = { finding, text: u.text }
    const detail = `${finding.name}, ${finding.kind}, ${finding.by} ${finding.confidence.toFixed(2)}`
    if (finding.confidence < MIN_CONFIDENCE) return this.log({ kind: 'rejected', text: u.text, detail: `${detail}: not sure enough` })

    let target = turn
    if (finding.kind === 'addressed_by_wearer') {
      // The person the wearer is talking to: whoever just spoke, else whoever speaks next.
      const before = this.lastTurn
      if (this.turn && this.turn.startMs >= u.startMs) target = this.turn
      else if (before && u.startMs - before.endMs <= ADDRESSED_BEFORE_MS) target = before
      else {
        this.addressed = { ...pending, untilMs: u.endMs + ADDRESSED_AFTER_MS }
        return this.log({ kind: 'name_found', text: u.text, detail: `${detail}; waiting for the next speaker` })
      }
    }
    if (!target) return
    if (target.voiceId && this.gallery.get(target.voiceId)?.name?.toLowerCase() === cleanName(finding.name)?.toLowerCase()) return // already known
    if (target.voiceId) this.log({ kind: 'name_found', text: u.text, voiceId: target.voiceId, voice: this.label(target.voiceId), detail })
    this.applyName(target, pending)
  }

  private applyName(turn: Turn, pending: PendingName) {
    const { finding, text } = pending
    if (!turn.voiceId) {
      turn.pendingName = pending
      // A turn that is already over gets no more voice: place the name now.
      if (turn !== this.turn) return void turn.queue.then(() => this.settleName(turn))
      return this.log({ kind: 'name_found', text, detail: `${finding.name}, ${finding.kind}, ${finding.by} ${finding.confidence.toFixed(2)}; waiting for enough of their voice` })
    }
    const before = this.gallery.get(turn.voiceId)
    if (before?.name && before.name.toLowerCase() === cleanName(finding.name)?.toLowerCase()) return
    const res = this.gallery.assignName(turn.voiceId, finding.name, {
      text, kind: finding.kind, confidence: finding.confidence, by: finding.by, at: new Date().toISOString(),
    })
    if (!res.ok) return this.log({ kind: 'rejected', text, voiceId: turn.voiceId, voice: this.label(turn.voiceId), detail: `${finding.name}: ${res.reason}` })
    if (this.current === turn.voiceId) this.current = res.voice.id
    for (const id of new Set([turn.voiceId, res.voice.id])) {
      for (const callback of this.namedCallbacks.get(id) ?? []) callback(res.voice.name!)
      this.namedCallbacks.delete(id)
    }
    turn.voiceId = res.voice.id
    this.log({ kind: 'named', text, voiceId: res.voice.id, voice: label(res.voice), detail: res.merged ? 'merged with the voice already saved under this name' : 'saved' })
    if (finding.kind !== 'addressed_by_wearer') this.describe(turn, res.voice.id)
  }
}
