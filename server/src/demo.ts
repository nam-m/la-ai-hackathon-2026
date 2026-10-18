import { config } from './config.js'
import * as store from './store.js'
import * as matcher from './matcher.js'
import type { QARecord, QuestionEvent, ToneRecord, TranscriptLine } from './types.js'

/**
 * Demo day (DEMO_DATA=1): a realistic morning for Rose (the wearer; VITE_WEARER_NAME in web/) and her daughter Sarah,
 * who writes the family notes. It's always there, with real asks, facts and Creao results layered on top in the same
 * store. Its facts and spoken answers are live, so the glasses answer from them too. Everything uses the `demo_` id
 * prefix and is replaced, never appended, so restarts don't duplicate it and real data is never touched. Times are
 * minutes before now, squeezed to fit after local midnight, so the day is always "today" and never in the future.
 */
export const DEMO_PREFIX = 'demo_'
export const isDemo = (id: string) => id.startsWith(DEMO_PREFIX)

const SPAN_MIN = 300 // the fixture's oldest offset

type Ask = { id: string; ago: number; question: string; worry: number | null; link?: Partial<QuestionEvent>; reply?: { name: string; text: string } }

const ASKS: Ask[] = [
  // Lunch: answered aloud as noon, then shown from that answer; Sarah's note later says 1pm, so the last ask shows nothing.
  { id: 'lunch1', ago: 280, question: 'What time is lunch?', worry: 0.12, link: { answerRecordId: 'demo_qa_lunch' }, reply: { name: 'Tom', text: 'Lunch is at noon.' } },
  { id: 'lunch2', ago: 210, question: 'When do we eat?', worry: 0.2, link: { matchedRecordId: 'demo_qa_lunch', matchScore: 0.91 } },
  { id: 'lunch3', ago: 130, question: 'What time is lunch?', worry: 0.38, link: { matchedRecordId: 'demo_qa_lunch', matchScore: 0.97 } },
  { id: 'lunch4', ago: 30, question: 'Is it lunch time yet?', worry: 0.58, link: { contradiction: { spokenRecordId: 'demo_qa_lunch', factRecordId: 'demo_fact_lunch' } } },
  // Mary: shown from the family note every time.
  { id: 'mary1', ago: 250, question: 'Where is Mary?', worry: 0.1, link: { matchedRecordId: 'demo_fact_mary', matchScore: 0.98 } },
  { id: 'mary2', ago: 160, question: 'Where’s Mary gone?', worry: 0.15, link: { matchedRecordId: 'demo_fact_mary', matchScore: 0.9 } },
  { id: 'mary3', ago: 90, question: 'Where is Mary?', worry: null, link: { matchedRecordId: 'demo_fact_mary', matchScore: 0.98 } },
  // Asked once. (Leo's weekly visit is left out: Sarah adds it in the web app on camera.)
  { id: 'rain1', ago: 70, question: 'Is it going to rain?', worry: 0.22 },
]

/**
 * Milliseconds since local midnight in the wearer's time zone. Seconds count: just after midnight, whole minutes
 * would give every ask the same time.
 */
function msSinceMidnight(now: Date) {
  const [h, m, sec] = new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .format(now).split(':').map(Number)
  return ((h * 60 + m) * 60 + sec) * 1000 + now.getMilliseconds()
}

/** Replaces the demo day with a fresh one for `now`'s local date. */
export function seedDemo(now = new Date()) {
  const since = msSinceMidnight(now)
  const margin = Math.min(5 * 60_000, since / 2)
  // The oldest ask lands at most 1 s after midnight; every offset scales by the same factor, so order is kept.
  const scale = Math.min(1, Math.max(0, since - margin - 1000) / (SPAN_MIN * 60_000))
  const at = (ago: number) => new Date(now.getTime() - margin - ago * 60_000 * scale).toISOString()

  store.removeByPrefix(DEMO_PREFIX)

  const record = (r: Partial<QARecord> & Pick<QARecord, 'id' | 'answer'>, ago: number): QARecord => ({
    question: null, askedAt: at(ago), answeredAt: at(ago), answeredBy: 'Sarah', source: 'family', standing: false, ...r,
  })
  const records = [
    record({ id: 'demo_fact_mary', question: 'Where is Mary?', answer: 'Mary is at the store, back by 3.' }, 300),
    record({ id: 'demo_fact_home', question: 'Where do I live?', answer: 'You live at 12 Oak Street with your daughter Sarah.', standing: true }, 300),
    record({ id: 'demo_fact_sarah', question: 'Who is Sarah?', answer: 'Sarah is your daughter.', standing: true }, 300),
    record({ id: 'demo_fact_lunch', question: 'What time is lunch?', answer: 'Lunch is at 1pm.' }, 60),
    record({ id: 'demo_reminder_pills', answer: 'Time to take your pills.', remindAt: at(120), reminderStatus: 'sent', reminderDoneAt: at(120) }, 300),
    record({ id: 'demo_qa_lunch', question: 'What time is lunch?', answer: 'Lunch is at noon.', answeredBy: 'Tom', source: 'spoken' }, 280),
  ]
  for (const r of records) {
    store.upsert(r)
    void matcher.warm(r).catch(() => undefined)
  }

  for (const a of ASKS) {
    const eventId = `demo_qe_${a.id}`
    const line = (suffix: string, l: Omit<TranscriptLine, 'id'>) => store.addTranscript({ id: `demo_tl_${a.id}_${suffix}`, ...l })
    line('q', { at: at(a.ago), role: 'wearer', name: null, text: a.question })
    if (a.reply) line('a', { at: at(a.ago - 0.3), role: 'other', name: a.reply.name, text: a.reply.text })
    store.addEvent({ id: eventId, at: at(a.ago), question: a.question, matchedRecordId: null, matchScore: null, ...a.link })
    const w = a.worry ?? 0
    const tone: ToneRecord = {
      id: `demo_tone_${a.id}`, questionEventId: eventId, at: at(a.ago), provider: 'demo',
      scores: { fearful: +(w * 0.6).toFixed(2), sad: +(w * 0.4).toFixed(2), neutral: +(1 - w).toFixed(2) },
      top: w > 0.3 ? ['fearful', 'neutral'] : ['neutral'], worry: w, quality: a.worry == null ? 'too_short' : 'ok',
    }
    store.addTone(tone)
  }

  // A real Creao summary wins; only fill in when there's none or the last one was ours.
  const date = store.localDate(now.toISOString())
  const existing = store.getDay(date)?.summary
  if (!existing || existing.demo === true) {
    store.saveSummary(date, {
      date, demo: true, generatedAt: at(15),
      summary: 'A mostly calm morning for Rose. She asked about lunch four times and sounded more worried each time: Tom ' +
        'said noon, but Sarah’s note says 1pm, so the glasses stopped answering. Worth fixing the note. Mary was asked about three ' +
        'times and the glasses answered from the family note each time. The pills reminder was delivered.',
    })
  }
  console.log(`[demo] seeded ${records.length} records, ${ASKS.length} questions for ${date}`)
}

/** Removes the demo day, e.g. when DEMO_DATA is turned off on a store that was seeded before. */
export function clearDemo() {
  store.removeByPrefix(DEMO_PREFIX)
  store.removeSummaries(s => s.demo === true)
}

/** Re-seed once the local day has turned over, so a server left running overnight still has a demo day. */
export function refreshIfStale() {
  if (!store.todaysEvents().some(e => isDemo(e.id))) seedDemo()
}
