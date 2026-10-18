// Turns the server's own records into the shape the CREAO care agents read (care-agents/seed/day-*.json).
import type { QARecord, QuestionEvent, ToneRecord } from '../types.js'

/** The server stores worry as 0..1; the agents read a boolean. 0.5 is a starting point to confirm with the tone owner. */
export const WORRY_THRESHOLD = 0.5

export type AgentEvent = {
  id: string
  at: string
  role: 'wearer'
  text: string
  matched_fact_id: string | null
  score: number | null
  decision: 'answered' | 'abstained'
  tone?: { top: string; worry: boolean; quality: 'ok' | 'low' }
}

/** Every server question event is a wearer question. With no tone record the tone key is left out, not marked low. */
export function toAgentEvents(events: QuestionEvent[], tones: ToneRecord[]): AgentEvent[] {
  const toneById = new Map(tones.map(t => [t.id, t]))
  return events.map(e => {
    const t = e.toneId ? toneById.get(e.toneId) : undefined
    const out: AgentEvent = {
      id: e.id,
      at: e.at,
      role: 'wearer',
      text: e.question,
      matched_fact_id: e.matchedRecordId,
      score: e.matchScore,
      decision: e.matchedRecordId ? 'answered' : 'abstained',
    }
    if (t) out.tone = { top: t.top[0] ?? 'unknown', worry: t.worry >= WORRY_THRESHOLD, quality: t.quality === 'ok' ? 'ok' : 'low' }
    return out
  })
}

/** Family facts only: what the glasses can answer from. */
export function toAgentFacts(records: QARecord[]) {
  return records.filter(r => r.source === 'family' && r.question).map(r => ({ id: r.id, question: r.question as string, answer: r.answer }))
}

/** The `data_json` string an agent reads instead of its built-in seed files. */
export function buildDataJson(
  dates: string[],
  events: QuestionEvent[],
  tones: ToneRecord[],
  records: QARecord[],
  localDate: (iso: string) => string,
): string {
  const agentEvents = toAgentEvents(events, tones)
  const days = dates.map(date => ({ date, events: agentEvents.filter(e => localDate(e.at) === date) }))
  return JSON.stringify({ days, facts: toAgentFacts(records) })
}

/** The `count` local dates ending at `endDate`, oldest first. */
export function datesEnding(endDate: string, count: number): string[] {
  const end = Date.parse(`${endDate}T12:00:00Z`)
  return Array.from({ length: count }, (_, i) => new Date(end - (count - 1 - i) * 86_400_000).toISOString().slice(0, 10))
}
