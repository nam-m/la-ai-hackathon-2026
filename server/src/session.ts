import type { WebSocket } from 'ws'
import { config } from './config.js'
import * as store from './store.js'
import * as matcher from './matcher.js'
import * as emotion from './emotion/index.js'
import { createSpeechModule, type QAPair, type SpeechModule, type Utterance } from './speech/index.js'
import { PcmRing } from './wav.js'
import type { PhoneMessage, QARecord, ServerMessage } from './types.js'

export const sessions = new Set<Session>()

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
  private lastHeard = Date.now() // any audio frame or JSON message (the phone pings every 15 s, even when paused)
  /** Per wearer question (utterance id): the pair check in progress or done, so only the first real reply is saved. */
  private pairChecks = new Map<string, Promise<boolean>>()
  /** A new wearer question closes the previous answer window (spec 6.4); replies only pair with the latest one. */
  private latestQuestionId: string | null = null

  constructor(private ws: WebSocket) {
    sessions.add(this)
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
    let msg: PhoneMessage
    try { msg = JSON.parse(raw) } catch { return void this.send({ v: 1, type: 'error', code: 'bad_audio', message: 'Bad JSON' }) }
    if (!msg || typeof msg !== 'object') return void this.send({ v: 1, type: 'error', code: 'bad_audio', message: 'Bad JSON' })

    switch (msg.type) {
      case 'hello':
        this.name = String(msg.session)
        console.log(`[ws ${this.name}] hello from ${msg.source}`)
        this.startSpeech()
        this.send({ v: 1, type: 'status', text: 'Listening' })
        break
      case 'control':
        if (msg.action === 'pause') {
          this.paused = true
          this.speech?.pause()
          this.send({ v: 1, type: 'clear' })
          this.send({ v: 1, type: 'status', text: 'Paused' })
        } else {
          this.paused = false
          this.speech?.resume()
          this.send({ v: 1, type: 'status', text: 'Listening' })
        }
        console.log(`[ws ${this.name}] ${msg.action}`)
        break
      case 'ping':
        this.send({ v: 1, type: 'pong' })
        break
    }
  }

  private onAudio(pcm: Buffer) {
    if (this.paused || !this.speech) return
    if (pcm.length % 2 !== 0) return void this.send({ v: 1, type: 'error', code: 'bad_audio', message: 'Odd-length PCM frame' })
    this.ring.push(pcm)
    this.speech.pushAudio(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
  }

  private startSpeech() {
    if (this.speech) return
    this.speech = createSpeechModule({
      provider: config.speechProvider,
      apiKey: config.speechApiKey,
      onUtterance: u => this.onUtterance(u),
      onWearerQuestion: q => void this.onQuestion(q),
      onPair: p => this.onPair(p),
      onError: e => {
        console.warn(`[speech ${this.name}]`, e.message)
        this.send({ v: 1, type: 'error', code: 'stt_down', message: 'Transcription unavailable' })
      },
    })
  }

  private onUtterance(u: Utterance) {
    console.log(`[speech ${this.name}] ${u.role === 'wearer' ? 'WEARER' : u.role === 'unknown' ? '?' : (u.name ?? u.speaker ?? 'other')}: ${u.text}`)
    store.addTranscript({ id: u.id + '_' + Date.now().toString(36), at: new Date().toISOString(), role: u.role, name: u.role === 'other' ? u.name : null, text: u.text })
  }

  private async onQuestion(q: Utterance) {
    if (q.role !== 'wearer') return // only the wearer's own questions (spec 6.1); B shouldn't send others, but be sure
    this.latestQuestionId = q.id
    const eventId = store.newId('qe')
    store.addEvent({ id: eventId, at: new Date().toISOString(), question: q.text, matchedRecordId: null, matchScore: null })

    // Tone runs beside matching and is never awaited here.
    void emotion.analyzeQuestion(eventId, this.ring.get(q.startMs, q.endMs))

    const { match, log } = await matcher.findMatch(q.text)
    console.log(`[match ${this.name}]`, JSON.stringify(log))
    // Spec 6.3: a spoken answer that disagrees with a family fact shows nothing; the dashboard flags it for the family.
    if (log.contradiction) store.updateEvent(eventId, { contradiction: log.contradiction })
    if (!match) return
    store.updateEvent(eventId, { matchedRecordId: match.record.id, matchScore: +match.score.toFixed(3) })
    if (this.paused) return
    // Recheck at delivery: the fact may have been edited, deleted or expired while we were matching (spec 6.5).
    const current = store.get(match.record.id)
    if (!current || current.answer !== match.record.answer) return void console.log(`[match ${this.name}] dropped ${match.record.id}: changed since match`)
    this.send(answerMessage(current))
  }

  /**
   * Save a spoken pair, but only a wearer question with an attributable answer that really replies to it (spec 6.4).
   * B calls onPair for every `other` utterance in the 30 s window; the earliest-spoken one that passes is saved (checks
   * run one at a time, in the order B reports them) and later ones are ignored, so "hmm, let me think" doesn't lose the
   * real answer. A newer wearer question closes the window.
   */
  private onPair(p: QAPair) {
    const qid = p.question.id
    if (this.latestQuestionId && qid !== this.latestQuestionId) {
      return console.log(`[store ${this.name}] skipped pair, newer question asked: "${p.question.text}" -> "${p.answer.text}"`)
    }
    const previous = this.pairChecks.get(qid) ?? Promise.resolve(false)
    // Chain per question so two candidates checked at once can't both be saved.
    const next = previous.then(saved => saved || this.tryPair(p))
    this.pairChecks.set(qid, next)
    if (this.pairChecks.size > 50) this.pairChecks.delete(this.pairChecks.keys().next().value!) // old windows are long closed
  }

  private async tryPair(p: QAPair): Promise<boolean> {
    const answeredAt = Date.now()
    if (p.question.role !== 'wearer' || p.answer.role !== 'other') {
      console.log(`[store ${this.name}] skipped pair, roles ${p.question.role} -> ${p.answer.role}`)
      return false
    }
    if (!(await matcher.isReply(p.question.text, p.answer.text))) {
      console.log(`[store ${this.name}] not a reply, window stays open: "${p.question.text}" -> "${p.answer.text}"`)
      return false
    }
    const record: QARecord = {
      id: store.newId('qa'),
      question: p.question.text,
      answer: p.answer.text,
      askedAt: new Date(answeredAt - (p.answer.endMs - p.question.endMs)).toISOString(),
      answeredAt: new Date(answeredAt).toISOString(),
      answeredBy: p.answer.name,
      source: 'spoken',
      standing: false,
    }
    store.upsert(record)
    void matcher.warm(record)
    // Link the ask that produced this answer, so it counts with its later repeats.
    const ask = [...store.todaysEvents()].reverse().find(e => e.question === p.question.text)
    if (ask) store.updateEvent(ask.id, { answerRecordId: record.id })
    console.log(`[store] pair ${record.id}: "${record.question}" -> "${record.answer}"`)
    return true
  }

  private close() {
    if (!sessions.delete(this)) return
    console.log(`[ws ${this.name}] closed`)
    void this.speech?.close()
  }
}
