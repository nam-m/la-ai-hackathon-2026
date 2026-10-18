// Contract 2: speech module. B owns this file and replaces the providers.
// Only role 'wearer' questions and role 'other' answers may form pairs. Call onPair for every `other`
// utterance within 30 s of the question (not just the first); the server saves the first that replies to it.
// C's server only uses createSpeechModule() and the types below.
import fs from 'node:fs'

export type Utterance = {
  id: string
  text: string
  // Milliseconds from the session's first audio byte, counting every byte passed to pushAudio (silence too).
  // The server cuts tone audio from its own buffer on this clock (spec v4.1 section 9).
  startMs: number
  endMs: number
  rmsDb: number
  speaker: string | null // provider label; null with ElevenLabs
  name: string | null // family name if known
  // B decides: 'wearer' (calibrated loudness or label), 'other', or 'unknown' when unsure or overlapping.
  // Unknown speech is never a question or an answer (spec v4.1 sections 5, 6.4).
  role: 'wearer' | 'other' | 'unknown'
  isWearer: boolean // same as role === 'wearer', kept for older code
}

export type QAPair = { question: Utterance; answer: Utterance }

export interface SpeechModule {
  pushAudio(pcm: Uint8Array): void
  pause(): void
  resume(): void
  close(): Promise<void>
}

export type SpeechOptions = {
  provider: 'elevenlabs' | 'deepgram' | 'fake'
  apiKey: string
  onUtterance(u: Utterance): void
  onWearerQuestion(q: Utterance): void // as soon as the question is final
  onPair(p: QAPair): void // for each `other` utterance within 30 s of the question; the server keeps the first real reply
  onError(e: Error): void
}

export function createSpeechModule(opts: SpeechOptions): SpeechModule {
  if (opts.provider === 'fake') return createFakeSpeech(opts)
  // B: add deepgram / elevenlabs here.
  opts.onError(new Error(`speech provider "${opts.provider}" not implemented yet; using fake`))
  return createFakeSpeech(opts)
}

/**
 * Fake provider: replays scripts/fake-script.txt on a timer, ignoring the audio.
 * Line format: "<delay seconds> | <wearer|Name|unknown> | <text>"
 */
function createFakeSpeech(opts: SpeechOptions): SpeechModule {
  const scriptPath = new URL('../../scripts/fake-script.txt', import.meta.url)
  const lines = fs.readFileSync(scriptPath, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  const started = Date.now()
  let paused = false
  let closed = false
  let n = 0
  let pending: { q: Utterance; at: number } | null = null
  const timers: NodeJS.Timeout[] = []

  let delay = 0
  for (const line of lines) {
    const [secs, who, ...rest] = line.split('|').map(s => s.trim())
    delay += Number(secs) * 1000
    const text = rest.join('|')
    timers.push(setTimeout(() => {
      if (paused || closed) return
      const now = Date.now() - started
      const wearer = who.toLowerCase() === 'wearer'
      const u: Utterance = {
        id: `utt_${n++}`, text, startMs: now - 1500, endMs: now,
        rmsDb: wearer ? -18 : -34, speaker: wearer ? '0' : who, name: wearer ? null : who,
        role: wearer ? 'wearer' : who.toLowerCase() === 'unknown' ? 'unknown' : 'other', isWearer: wearer,
      }
      opts.onUtterance(u)
      const isQuestion = wearer && /\?\s*$/.test(text)
      if (isQuestion) {
        pending = { q: u, at: Date.now() }
        opts.onWearerQuestion(u)
      } else if (u.role === 'other' && pending && Date.now() - pending.at < 30_000) {
        // Every `other` line in the window is a candidate; the server keeps the first real reply.
        opts.onPair({ question: pending.q, answer: u })
      }
    }, delay))
  }

  return {
    pushAudio() {},
    pause() { paused = true },
    resume() { paused = false },
    async close() { closed = true; timers.forEach(clearTimeout) },
  }
}
