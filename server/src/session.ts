import type { WebSocket } from 'ws'
import { config } from './config.js'
import * as store from './store.js'
import * as matcher from './matcher.js'
import * as emotion from './emotion/index.js'
import { createSpeechModule, type QAPair, type SpeechModule, type SpeechOptions, type Utterance } from './speech/index.js'
import { PcmRing } from './wav.js'
import { RoleTimeline, isGlassesRole } from './glasses-role.js'
import * as voiceClient from './voices/client.js'
import { extractName } from './voices/names.js'
import { VoiceTracker } from './voices/tracker.js'
import type { PhoneMessage, QARecord, ServerMessage } from './types.js'

export const sessions = new Set<Session>()

/** Injectable external boundaries for offline contract tests. */
export type SessionDependencies = {
  createSpeech: (options: SpeechOptions) => SpeechModule
  findMatch: typeof matcher.findMatch
  isReply: typeof matcher.isReply
  warm: typeof matcher.warm
  analyzeQuestion: typeof emotion.analyzeQuestion
  /** Voice recognition (voices/); off unless VOICE_URL is set or a test passes these. */
  embedVoice?: typeof voiceClient.embed
  extractName?: typeof extractName
}
const defaultDependencies: SessionDependencies = {
  createSpeech: createSpeechModule, findMatch: matcher.findMatch, isReply: matcher.isReply,
  warm: matcher.warm, analyzeQuestion: emotion.analyzeQuestion,
}

/** How long a spoken pair waits for the answerer's voice check, so the glasses can say "Kevin · 10:40 AM". */
const ANSWERER_WAIT_MS = 1500

export function formatTime(iso: string) {
  return new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
}

export function answerMessage(r: QARecord): ServerMessage {
  return { v: 1, type: 'answer', id: r.id, text: r.answer, speaker: r.answeredBy, at: formatTime(r.answeredAt), source: r.source }
}

/** One connected phone. */
export class Session {
  private speech: SpeechModule | null = null
  private paused = false
  private name = 'unknown'
  /** Last 60 s of audio, addressed by ms since this session's first audio byte (same clock as Utterance.startMs/endMs). */
  private ring = new PcmRing()
  /** The glasses' speakerRole tags from the phone, on the ring's clock. */
  private roles = new RoleTimeline()
  private lastHeard = Date.now() // any audio frame or JSON message (the phone pings every 15 s, even when paused)
  /** Per wearer question (utterance id): the pair check in progress or done, so only the first real reply is saved. */
  private pairChecks = new Map<string, Promise<boolean>>()
  /** A new wearer question closes the previous answer window (spec 6.4); replies only pair with the latest one. */
  private latestQuestionId: string | null = null
  private latestQuestionEventId: string | null = null
  private generation = 0
  private closed = false
  private speechUnavailable = false
  /** Who is talking to the wearer, by voice; null when voice recognition is off. */
  private voices: VoiceTracker | null = null

  constructor(private ws: WebSocket, private readonly dependencies: SessionDependencies = defaultDependencies) {
    sessions.add(this)
    if (dependencies.embedVoice || voiceClient.voiceEnabled()) {
      this.voices = new VoiceTracker({
        session: () => this.name,
        embed: dependencies.embedVoice ?? voiceClient.embed,
        extractName: dependencies.extractName ?? extractName,
        clip: (startMs, endMs) => this.ring.get(startMs, endMs),
        send: msg => { if (!this.closed && !this.paused) this.send(msg) },
      })
    }
    ws.on('message', (data, isBinary) => {
      this.lastHeard = Date.now()
      return isBinary ? this.onAudio(data as Buffer) : this.onJson(data.toString())
    })
    ws.on('close', () => this.close())
    ws.on('error', e => console.warn(`[ws ${this.name}] error`, e.message))
  }

  get isPaused() { return this.paused }

  send(msg: ServerMessage) {
    if (this.ws.readyState !== this.ws.OPEN) return false
    this.ws.send(JSON.stringify(msg))
    return true
  }

  /**
   * Idle check (spec v4.2, contract 1): close a connection that sent nothing, no audio and no ping, for 45 s
   * (locked phone, dropped Wi-Fi), so its paid speech stream closes. The app reconnects when it wakes.
   */
  closeIfIdle(maxIdleMs: number) {
    if (Date.now() - this.lastHeard <= maxIdleMs) return
    console.log(`[ws ${this.name}] idle ${Math.round((Date.now() - this.lastHeard) / 1000)}s, closing`)
    this.ws.terminate()
    this.close()
  }

  private onJson(raw: string) {
    if (this.closed) return
    let msg: PhoneMessage
    try { msg = JSON.parse(raw) } catch { return void this.send({ v: 1, type: 'error', code: 'bad_audio', message: 'Bad JSON' }) }
    if (!msg || typeof msg !== 'object') return void this.send({ v: 1, type: 'error', code: 'bad_audio', message: 'Bad JSON' })

    switch (msg.type) {
      case 'hello':
        this.name = String(msg.session)
        console.log(`[ws ${this.name}] hello from ${msg.source}`)
        this.startSpeech()
        if (this.paused || (this.speech && !this.speechUnavailable)) this.send({ v: 1, type: 'status', text: this.paused ? 'Paused' : 'Listening' })
        break
      case 'control':
        if (msg.action === 'pause') {
          this.paused = true
          this.invalidateWindow()
          this.speech?.pause()
          this.send({ v: 1, type: 'clear' })
          this.send({ v: 1, type: 'status', text: 'Paused' })
        } else if (msg.action === 'resume') {
          this.paused = false
          this.speechUnavailable = false
          try {
            if (this.speech) this.speech.resume()
            else this.startSpeech()
          } catch { this.speechError() }
          if (this.speech && !this.speechUnavailable) this.send({ v: 1, type: 'status', text: 'Listening' })
        }
        console.log(`[ws ${this.name}] ${msg.action}`)
        break
      case 'ping':
        this.send({ v: 1, type: 'pong' })
        break
      case 'role':
        // The glasses' speakerRole for the audio frames that follow (sent only when it changes).
        if (isGlassesRole(msg.role)) this.roles.set(msg.role)
        break
    }
  }

  private onAudio(pcm: Buffer) {
    if (this.closed || this.paused || !this.speech) return
    if (pcm.length % 2 !== 0 || pcm.length > 320_000) return void this.send({ v: 1, type: 'error', code: 'bad_audio', message: 'Expected complete PCM samples in chunks of at most 10 seconds' })
    if (!pcm.length) return
    this.ring.push(pcm)
    this.roles.addAudio(pcm.length)
    this.speech.pushAudio(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
  }

  private startSpeech() {
    if (this.speech || this.closed || this.paused) return
    this.speechUnavailable = false
    try {
      this.speech = this.dependencies.createSpeech({
        ...config.speechOptions,
        // Who spoke comes from the glasses' own tags when the phone sends them (SPEECH_ROLE_SOURCE=glasses).
        roleAt: config.speechRoleSource === 'glasses' ? (startMs, endMs) => this.roles.roleAt(startMs, endMs) : undefined,
        onUtterance: u => this.onUtterance(u),
        onWearerQuestion: q => {
          // A matcher/store failure is not a transcription outage: log it, drop this question's
          // window, and keep listening instead of telling the phone transcription is down.
          void this.onQuestion(q).catch(e => {
            console.warn(`[match ${this.name}] question handling failed: ${(e as Error).message}`)
            if (this.latestQuestionId === q.id) this.invalidateWindow()
          })
        },
        onPair: p => this.onPair(p),
        onError: () => this.speechError(),
      })
    } catch { this.speechError() }
  }

  private invalidateWindow() {
    this.generation++
    this.latestQuestionId = null
    this.latestQuestionEventId = null
    this.pairChecks.clear()
  }

  private speechError() {
    this.speechUnavailable = true
    this.invalidateWindow()
    this.send({ v: 1, type: 'error', code: 'stt_down', message: 'Transcription unavailable; check server speech configuration or resume to retry' })
  }

  private isCurrent(questionId: string, generation: number) {
    return !this.closed && !this.paused && this.generation === generation && this.latestQuestionId === questionId
  }

  private onUtterance(u: Utterance) {
    if (this.closed || this.paused) return
    console.log(`[speech ${this.name}] ${u.role === 'wearer' ? 'WEARER' : u.role === 'unknown' ? '?' : (u.name ?? u.speaker ?? 'other')}: ${u.text}`)
    const id = u.id + '_' + Date.now().toString(36)
    store.addTranscript({ id, at: new Date().toISOString(), role: u.role, name: u.role === 'other' ? u.name : null, text: u.text })
    this.voices?.onUtterance(u, id)
  }

  private async onQuestion(q: Utterance) {
    if (this.closed || this.paused || q.role !== 'wearer') return
    this.invalidateWindow()
    this.latestQuestionId = q.id
    const generation = this.generation
    const eventId = store.newId('qe')
    this.latestQuestionEventId = eventId
    store.addEvent({ id: eventId, at: new Date().toISOString(), question: q.text, matchedRecordId: null, matchScore: null })

    // Tone runs beside matching and is never awaited here.
    void this.dependencies.analyzeQuestion(eventId, this.ring.get(q.startMs, q.endMs)).catch(() => undefined)

    const { match, log } = await this.dependencies.findMatch(q.text)
    if (!this.isCurrent(q.id, generation)) return
    console.log(`[match ${this.name}]`, JSON.stringify(log))
    // Spec 6.3: a spoken answer that disagrees with a family fact shows nothing; the dashboard flags it for the family.
    if (log.contradiction) store.updateEvent(eventId, { contradiction: log.contradiction })
    if (!match) return
    // Recheck at delivery: the fact may have been edited, deleted or expired while we were matching (spec 6.5).
    const current = store.get(match.record.id)
    if (!current || current.answer !== match.record.answer) return void console.log(`[match ${this.name}] dropped ${match.record.id}: changed since match`)
    if (this.send(answerMessage(current))) {
      store.updateEvent(eventId, { matchedRecordId: match.record.id, matchScore: +match.score.toFixed(3) })
    }
  }

  /**
   * Save a spoken pair, but only a wearer question with an attributable answer that really replies to it (spec 6.4).
   * B calls onPair for every `other` utterance in the 30 s window; the earliest-spoken one that passes is saved (checks
   * run one at a time, in the order B reports them) and later ones are ignored, so "hmm, let me think" doesn't lose the
   * real answer. A newer wearer question closes the window.
   */
  private onPair(p: QAPair) {
    const qid = p.question.id
    const generation = this.generation
    if (!this.isCurrent(qid, generation)) return
    const answeredAt = Date.now()
    const previous = this.pairChecks.get(qid) ?? Promise.resolve(false)
    // Chain per question so two candidates checked at once can't both be saved.
    const next = previous.then(saved => saved || this.tryPair(p, generation, answeredAt)).catch(() => false)
    this.pairChecks.set(qid, next)
    if (this.pairChecks.size > 50) this.pairChecks.delete(this.pairChecks.keys().next().value!) // old windows are long closed
  }

  private async tryPair(p: QAPair, generation: number, answeredAt: number): Promise<boolean> {
    if (!this.isCurrent(p.question.id, generation)) return false
    const gap = p.answer.startMs - p.question.endMs
    if (p.question.role !== 'wearer' || p.answer.role !== 'other' || !Number.isFinite(gap) || gap < 0 || gap > 30_000) {
      console.log(`[store ${this.name}] skipped pair, roles ${p.question.role} -> ${p.answer.role}`)
      return false
    }
    const replies = await this.dependencies.isReply(p.question.text, p.answer.text)
    if (!this.isCurrent(p.question.id, generation)) return false
    if (!replies) {
      console.log(`[store ${this.name}] not a reply, window stays open: "${p.question.text}" -> "${p.answer.text}"`)
      return false
    }
    // Speech gives no names with ElevenLabs; the answerer's remembered voice may.
    const voice = p.answer.name ? null : await this.voices?.voiceFor(p.answer.id, ANSWERER_WAIT_MS)
    const answeredBy = p.answer.name ?? voice?.name ?? null
    if (!this.isCurrent(p.question.id, generation)) return false
    const record: QARecord = {
      id: store.newId('qa'),
      question: p.question.text,
      answer: p.answer.text,
      askedAt: new Date(answeredAt - (p.answer.endMs - p.question.endMs)).toISOString(),
      answeredAt: new Date(answeredAt).toISOString(),
      answeredBy,
      source: 'spoken',
      standing: false,
    }
    store.upsert(record)
    // Their name may come later ("Thanks, Sarah"); then this answer says who gave it too.
    if (!answeredBy) this.voices?.whenNamed(p.answer.id, name => {
      const saved = store.get(record.id)
      if (saved && !saved.answeredBy) store.upsert({ ...saved, answeredBy: name })
    })
    void this.dependencies.warm(record).catch(() => undefined)
    // Link the ask that produced this answer, so it counts with its later repeats.
    if (this.latestQuestionEventId) store.updateEvent(this.latestQuestionEventId, { answerRecordId: record.id })
    console.log(`[store] pair ${record.id}: "${record.question}" -> "${record.answer}"${answeredBy ? ` (${answeredBy})` : ''}`)
    return true
  }

  private close() {
    if (!sessions.delete(this)) return
    this.closed = true
    this.invalidateWindow()
    this.voices?.close()
    console.log(`[ws ${this.name}] closed`)
    void this.speech?.close().catch(() => undefined)
  }
}
