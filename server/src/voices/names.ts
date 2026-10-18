// Names heard in conversation: "Hi, I'm Kevin", "Kevin." after "What's your name?", "Thanks, Sarah".
// Only the newest line is judged; the earlier ones are context. Claude decides when there is a key,
// otherwise a few plain patterns. A cheap filter keeps most lines away from Claude.
import { config } from '../config.js'
import { claudeText } from '../matcher.js'
import type { NameEvidence } from '../types.js'

export type NameLine = { role: 'wearer' | 'other' | 'unknown'; text: string; voice: string | null }
export type NameKind = Exclude<NameEvidence['kind'], 'manual'>
export type NameFinding = { name: string; kind: NameKind; confidence: number; by: 'claude' | 'pattern' }

export const MIN_CONFIDENCE = 0.6

// Capitalized words that are not names (sentence starts are skipped anyway).
const NOT_NAMES = new Set(('I I\'m I\'ll I\'ve I\'d OK Okay Oh Mom Dad Mum Grandma Grandpa Doctor Dr Mr Mrs Ms Sir Madam God Lord ' +
  'Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September ' +
  'October November December Christmas Easter English TV Hi Hello Hey Yes No Thanks Sorry Please Good Fine Well Uh Um Huh Hmm Ah Wow').split(' '))
const ASKS_NAME = /\b(your name|who are you|who is this|who's this|remind me who)\b/i
const INTRO = /\b(my name|call me|i'm|i am|this is|it's|it is|name's)\b/i

const capitalizedWords = (text: string) => {
  const words: string[] = []
  // Words after a sentence start only, so "Lunch is ready." doesn't look like a name.
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const ws = sentence.split(/\s+/)
    ws.forEach((w, i) => {
      const bare = w.replace(/[.,!?;:"“”]+$/g, '')
      if (/^\p{Lu}[\p{Ll}'-]+$/u.test(bare) && !NOT_NAMES.has(bare) && (i > 0 || /,$/.test(w))) words.push(bare)
    })
  }
  return words
}

// Questions about who someone is. "Who are you?" depends on whom it is asked, so it is never stored or matched as
// a pair; voice recognition answers it. "Who is Kevin?" is answered from what Kevin said about himself.
const WHO_ARE_YOU = /^(?:(?:sorry|excuse me|hi|hello|um|uh|so|and|wait|okay|ok)[,.]?\s+)*(?:who are you|who's this|who is this|what's your name|what is your name|remind me who you are|do i know you|have we met)(?:\s+again)?(?:,?\s+(?:sorry|again|please))?\s*[?.!]*$/i
const WHO_IS = /^(?:(?:sorry|excuse me|um|uh|so|and|wait|okay|ok)[,.]?\s+)*who(?:'s| is| was)\s+(?:the\s+)?(\p{L}[\p{L}'-]+)(?:\s+again)?\s*[?.!]*$/iu
const NOT_A_PERSON = new Set(['this', 'that', 'it', 'he', 'she', 'there', 'here', 'coming', 'visiting', 'next', 'calling', 'that?', 'they'])

export const isWhoAreYou = (text: string) => WHO_ARE_YOU.test(text.trim())
/** "Who is Kevin?" -> "Kevin"; null for any other question. */
export function whoIsName(text: string): string | null {
  const m = WHO_IS.exec(text.trim())
  return m && !NOT_A_PERSON.has(m[1].toLowerCase()) ? m[1] : null
}

/** Is the newest line worth a Claude call? */
export function mightHaveName(lines: NameLine[]) {
  const last = lines[lines.length - 1]
  if (!last || last.role === 'unknown') return false
  const prev = [...lines.slice(0, -1)].reverse().find(l => l.role !== last.role)
  if (last.role === 'other' && prev?.role === 'wearer' && ASKS_NAME.test(prev.text)) return true
  return capitalizedWords(last.text).length > 0 || (last.role === 'other' && /\b(my name|call me)\b/i.test(last.text))
}

/** The plain patterns, used without an Anthropic key: self-introductions and a short reply to a name question. */
export function patternName(lines: NameLine[]): NameFinding | null {
  const last = lines[lines.length - 1]
  if (!last || last.role !== 'other') return null
  const intro = /\b(?:[Mm]y name is|[Mm]y name's|I'm|I am|[Cc]all me)\s+(\p{Lu}[\p{Ll}'-]+)/u.exec(last.text)
  if (intro && !NOT_NAMES.has(intro[1])) return { name: intro[1], kind: 'self_intro', confidence: 0.8, by: 'pattern' }
  const prev = [...lines.slice(0, -1)].reverse().find(l => l.role === 'wearer')
  const words = last.text.replace(/[.,!?]/g, '').split(/\s+/).filter(Boolean)
  if (prev && ASKS_NAME.test(prev.text) && words.length <= 3) {
    const name = words.find(w => /^\p{Lu}[\p{Ll}'-]+$/u.test(w) && !NOT_NAMES.has(w) && !/^(It's|It|I'm|Is|My)$/.test(w))
    if (name) return { name, kind: 'answer_to_name_question', confidence: 0.75, by: 'pattern' }
  }
  return null
}

function prompt(lines: NameLine[]) {
  const shown = lines.map((l, i) => `[${i + 1}] ${l.role === 'wearer' ? 'WEARER' : l.role === 'other' ? `OTHER${l.voice ? ` (${l.voice})` : ''}` : 'UNCLEAR'}: ${l.text}`)
  return `Smart glasses help a person with memory loss remember who they are talking to. WEARER is the person wearing the glasses; OTHER is someone talking with them (their voice in brackets when known).

Does the LAST line reveal the first name of an OTHER person in this conversation?
Count only:
- self_intro: the last line is OTHER giving their own name ("Hi, I'm Kevin", "It's Sarah from next door", "My name is Ana").
- answer_to_name_question: the last line is OTHER answering the wearer's question about their name ("Kevin.").
- addressed_by_wearer: the last line is WEARER calling the person they are talking with by name ("Thanks, Sarah", "Hi Tom!"). Several OTHER voices in the lines are fine: the app decides which of them is meant.
Never count: people who are only mentioned ("Mary is coming at five", "Ask John", "Your son called"), the wearer's own name, pets, places, brands, or titles (Mom, Doctor, Nurse).

Lines:
${shown.join('\n')}

confidence: 0.9 or more when the line plainly gives or uses the name this way; lower only when the word may not be a name or may name someone who isn't here.

Reply with only this JSON object and no other words: {"name": "<first name>", "kind": "self_intro" | "answer_to_name_question" | "addressed_by_wearer", "confidence": <0 to 1>} or {"name": null}`
}

const KINDS: NameKind[] = ['self_intro', 'answer_to_name_question', 'addressed_by_wearer']

/** The name the newest line reveals, if any. Claude when there is a key; errors count as no name. */
export async function extractName(lines: NameLine[]): Promise<NameFinding | null> {
  if (!config.anthropicApiKey) return patternName(lines)
  // Room for a sentence of reasoning before the JSON: it sometimes writes one despite being asked not to.
  const raw = await claudeText(prompt(lines), 300, 6000)
  const json = /\{[\s\S]*?\}/.exec(raw)?.[0] // the first object: Haiku sometimes adds a second one
  if (!json) return null
  const r = JSON.parse(json) as { name?: unknown; kind?: unknown; confidence?: unknown }
  if (typeof r.name !== 'string' || !r.name.trim() || !KINDS.includes(r.kind as NameKind)) return null
  const last = lines[lines.length - 1]
  // The kind must fit who said the last line.
  if ((r.kind === 'addressed_by_wearer') !== (last.role === 'wearer')) return null
  return { name: r.name.trim(), kind: r.kind as NameKind, confidence: typeof r.confidence === 'number' ? r.confidence : 0, by: 'claude' }
}
