// Updates nobody asked for: "Lunch moved to 1" said after "Lunch is at noon" was stored, with no question open.
// Saved word for word as a newer answer to the same question; the matcher already prefers the newest spoken answer.
import { config } from './config.js'
import { claudeText } from './matcher.js'
import type { QARecord } from './types.js'

// Words that say nothing about which thing a line is about.
const GENERIC = new Set(('the and are was were for with what when where who how why does did you your yours my mine our ours they them their ' +
  'this that these those there here yes yeah okay just will would could should can going gonna get got have has had about been being ' +
  'time today tonight tomorrow now then later soon still also too very really right well sure thing things know think want need come ' +
  'coming back okay alright sorry please thanks thank one two three four five six seven eight nine ten twelve noon').split(' '))
// Signs a line carries new facts: a time, a change, a day.
const NEWS = /\d|\b(moved?|changed?|instead|now|actually|cancel+ed|postponed|pushed|later|earlier|no longer|anymore|tomorrow|tonight|today|noon|midnight|o'clock|a\.?m\.?|p\.?m\.?)\b/i

const topicWords = (text: string) => new Set((text.toLowerCase().match(/[a-z']+/g) ?? []).map(w => w.replace(/'s$/, '')).filter(w => w.length > 2 && !GENERIC.has(w)))

/** Today's answers this line might update: it shares a topic word with them and carries a sign of news. Cheap; no model. */
export function mightUpdate(text: string, records: QARecord[]): QARecord[] {
  if ((text.match(/[a-z']+/gi) ?? []).length < 3 || !NEWS.test(text)) return []
  const words = topicWords(text)
  return records.filter(r => r.question && [...topicWords(`${r.question} ${r.answer}`)].some(w => words.has(w)))
}

const normalize = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()

/** The answer this line replaces, if Claude is sure it is an update. Without a key nothing is guessed. */
export async function findUpdate(text: string, candidates: QARecord[]): Promise<QARecord | null> {
  if (!config.anthropicApiKey || !candidates.length) return null
  const list = candidates.map((r, i) => `[${i + 1}] Q: ${r.question} A: ${r.answer}`).join('\n')
  const raw = await claudeText(
    'Smart glasses keep the answers a person with memory loss was given today, to show them again when the question is repeated. ' +
    'Someone near them just said the line below. Does it UPDATE one of these answers: new information about the very same thing that makes ' +
    'the stored answer out of date (a new time, place or plan; a cancellation)? ' +
    'Not an update: small talk, a different event or person, repeating or agreeing with the stored answer, or a question.\n' +
    `Answers:\n${list}\nLine: "${text}"\n` +
    'Reply with only this JSON object and no other words: {"update": <answer number>} or {"update": null}',
    300, 6000)
  const json = /\{[\s\S]*?\}/.exec(raw)?.[0]
  if (!json) return null
  const n = (JSON.parse(json) as { update?: unknown }).update
  const target = typeof n === 'number' ? candidates[n - 1] : undefined
  return target && normalize(target.answer) !== normalize(text) ? target : null
}
