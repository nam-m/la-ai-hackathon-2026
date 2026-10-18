import { config } from './config.js'
import * as store from './store.js'
import type { QARecord } from './types.js'

/**
 * Repeat matcher.
 * 1. Embed the new question, compare with every stored question (cosine).
 * 2. Candidates above MATCH_THRESHOLD, preferring the newest spoken answer, then family facts.
 * 3. Yes/no double-check with a fast model. It never writes the answer.
 * 4. A spoken answer that contradicts a matching family fact means nothing is shown.
 * Any failure returns null: showing nothing is always safe.
 */

export type MatchResult = { record: QARecord; score: number }
export type MatchLog = {
  question: string
  best?: { id: string; question: string; score: number }
  decision: string
  ms: number
  contradiction?: { spokenRecordId: string; factRecordId: string }
}

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models'
const useGemini = () => Boolean(config.geminiApiKey)
const DEADLINE_MS = 2000 // whole match, question end to decision (spec 6.2: timeout returns nothing)

// ---------- embeddings ----------

async function geminiEmbed(text: string): Promise<number[]> {
  const res = await fetch(`${GEMINI}/${config.embedModel}:embedContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': config.geminiApiKey },
    body: JSON.stringify({ content: { parts: [{ text }] }, taskType: 'SEMANTIC_SIMILARITY' }),
    signal: AbortSignal.timeout(2000),
  })
  if (!res.ok) throw new Error(`embed ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as { embedding: { values: number[] } }
  return json.embedding.values
}

// Offline fallback: bag of words with a few synonyms. Good enough to test the pipeline.
// Question words are left out of similarity; sameQuestion() checks them separately.
const STOP = new Set('a an the is are am do does did to of in on at for my me i you we it be will what s when where who why how'.split(' '))
const SYN: Record<string, string> = { eat: 'lunch', eating: 'lunch', food: 'lunch', lunchtime: 'lunch', dinner: 'dinner', supper: 'dinner', mom: 'mary', wife: 'mary', daughter: 'sarah', coming: 'visit', visiting: 'visit', home: 'home', house: 'home' }
const words = (t: string) =>
  t.toLowerCase().replace(/[^a-z\s']/g, ' ').replace(/'s\b/g, '').split(/\s+/).filter(w => w && !STOP.has(w)).map(w => SYN[w] ?? w.replace(/(ing|ed|s)$/, ''))
function localEmbed(text: string): Map<string, number> {
  const m = new Map<string, number>()
  for (const w of words(text)) m.set(w, (m.get(w) ?? 0) + 1)
  return m
}
function localCosine(a: Map<string, number>, b: Map<string, number>) {
  let dot = 0, na = 0, nb = 0
  for (const [k, v] of a) { dot += v * (b.get(k) ?? 0); na += v * v }
  for (const v of b.values()) nb += v * v
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

function cosine(a: number[], b: number[]) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

async function embedRecord(r: QARecord): Promise<number[] | undefined> {
  const cached = store.getEmbedding(r.id)
  if (cached) return cached
  if (!r.question) return undefined
  const vec = await geminiEmbed(r.question)
  store.setEmbedding(r.id, vec)
  return vec
}

/** Embed ahead of time so matching only embeds the new question. */
export async function warm(r: QARecord) {
  if (!useGemini() || !r.question) return
  try { await embedRecord(r) } catch (e) { console.warn('[matcher] warm failed', (e as Error).message) }
}

// ---------- yes/no checks ----------

const WH = ['when', 'where', 'who', 'why', 'how']
const whWord = (q: string) =>
  /\bwhat time\b|\bhow long until\b/i.test(q) ? 'when' : WH.find(w => new RegExp(`\\b${w}`, 'i').test(q))

async function sameQuestion(a: string, b: string): Promise<boolean> {
  if (!useGemini()) {
    // Offline: reject different question words ("when" vs "where").
    const wa = whWord(a), wb = whWord(b)
    return !(wa && wb && wa !== wb)
  }
  return askYesNo(
    'Do these two questions ask for the same information? Answer only yes or no.\n' +
    `Question 1: ${a}\nQuestion 2: ${b}`,
  )
}

/** Do two stored answers agree? Used to stay silent when a spoken answer and a family fact contradict (spec 6.3). */
async function sameAnswer(a: string, b: string): Promise<boolean> {
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
  if (norm(a) === norm(b)) return true
  if (!useGemini()) return false // offline: different wording counts as a contradiction (safe side)
  return askYesNo(
    'Do these two statements give the same information, without contradicting each other? Answer only yes or no.\n' +
    `Statement 1: ${a}\nStatement 2: ${b}`,
  )
}

/**
 * Before saving a spoken pair: is the answer actually a reply to the question?
 * Stops "the next thing anyone said" from being stored as an answer. Offline: yes.
 */
export async function isReply(question: string, answer: string): Promise<boolean> {
  if (!useGemini()) return true
  try {
    return await askYesNo(
      'Someone asked a question and the next thing another person said is below. ' +
      'Is it a direct answer to the question? Answer only yes or no.\n' +
      `Question: ${question}\nReply: ${answer}`,
    )
  } catch (e) {
    console.warn('[matcher] isReply failed', (e as Error).message)
    return false
  }
}

async function askYesNo(prompt: string): Promise<boolean> {
  const res = await fetch(`${GEMINI}/${config.verifyModel}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': config.geminiApiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 5, thinkingConfig: { thinkingBudget: 0 } },
    }),
    signal: AbortSignal.timeout(1500),
  })
  if (!res.ok) throw new Error(`verify ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  return /^\s*yes/i.test(text)
}

// ---------- match ----------

/** Whole match, question to decision, within DEADLINE_MS. A late answer is worse than none. */
export async function findMatch(question: string): Promise<{ match: MatchResult | null; log: MatchLog }> {
  const t0 = Date.now()
  const log: MatchLog = { question, decision: 'no candidates', ms: 0 }
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<null>(r => { timer = setTimeout(() => { log.decision = 'deadline exceeded'; r(null) }, DEADLINE_MS) })
  let match: MatchResult | null
  try {
    match = await Promise.race([decide(question, log), deadline])
  } catch (e) {
    log.decision = `error: ${(e as Error).message}`
    match = null
  } finally {
    clearTimeout(timer)
  }
  log.ms = Date.now() - t0
  return { match, log }
}

async function decide(question: string, log: MatchLog): Promise<MatchResult | null> {
  const records = store.answerable().filter(r => !r.remindAt)
  if (!records.length) return null

  let scored: MatchResult[]
  if (useGemini()) {
    const qVec = await geminiEmbed(question)
    scored = []
    for (const r of records) {
      // Never embed stored questions in the live path; warm misses in the background.
      const vec = store.getEmbedding(r.id)
      if (vec) scored.push({ record: r, score: cosine(qVec, vec) })
      else void warm(r)
    }
  } else {
    const q = localEmbed(question)
    scored = records.map(r => ({ record: r, score: localCosine(q, localEmbed(r.question!)) }))
  }
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  if (best) log.best = { id: best.record.id, question: best.record.question!, score: +best.score.toFixed(3) }

  const threshold = useGemini() ? config.matchThreshold : 0.6
  const candidates = scored.filter(s => s.score >= threshold)
  if (!candidates.length) { log.decision = 'below threshold'; return null }

  // Near-ties first, newest spoken answer before family facts; then the rest by score.
  const nearTie = candidates.filter(c => c.score >= candidates[0].score - 0.03)
  nearTie.sort((a, b) => {
    if (a.record.source !== b.record.source) return a.record.source === 'spoken' ? -1 : 1
    return b.record.answeredAt.localeCompare(a.record.answeredAt)
  })
  const ranked = [...nearTie, ...candidates.filter(c => !nearTie.includes(c))].slice(0, 3)

  // Double-check the top few in parallel; keep the highest-ranked yes.
  const verdicts = await Promise.all(ranked.map(c => sameQuestion(question, c.record.question!).catch(() => false)))
  const verified = ranked.filter((_, i) => verdicts[i])
  const chosen = verified[0]
  if (!chosen) { log.decision = 'rejected by double-check'; return null }

  // Spec 6.3: a newer spoken answer replaces older spoken ones, but if it disagrees with a family fact
  // for the same question, show nothing.
  const other = verified.find(v => v.record.source !== chosen.record.source)
  if (other && !(await sameAnswer(chosen.record.answer, other.record.answer).catch(() => false))) {
    log.decision = `contradiction ${chosen.record.id} vs ${other.record.id}`
    const spoken = chosen.record.source === 'spoken' ? chosen : other
    log.contradiction = { spokenRecordId: spoken.record.id, factRecordId: (spoken === chosen ? other : chosen).record.id }
    return null
  }

  log.decision = `match ${chosen.record.id}`
  log.best = { id: chosen.record.id, question: chosen.record.question!, score: +chosen.score.toFixed(3) }
  return chosen
}
