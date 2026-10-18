import * as store from './store.js'
import * as matcher from './matcher.js'
import type { FactInput, QARecord } from './types.js'

const isDate = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v))

/** Why a fact is unusable, or null if it's fine. A fact needs an answer plus a question or a valid remindAt. */
export function factProblem(f: FactInput | undefined): string | null {
  if (!f || typeof f !== 'object' || typeof f.id !== 'string' || !f.id) return 'missing id'
  if (typeof f.answer !== 'string' || !f.answer.trim()) return 'missing answer'
  if (f.question != null && typeof f.question !== 'string') return 'question must be a string or null'
  if (f.remindAt != null && !isDate(f.remindAt)) return 'bad remindAt'
  if (f.expiresAt != null && !isDate(f.expiresAt)) return 'bad expiresAt'
  if (!(typeof f.question === 'string' && f.question.trim()) && f.remindAt == null) return 'needs a question or remindAt'
  return null
}

/** Stores family facts (source "family") word for word. One path for POST /facts and for Creao facts runs. */
export function saveFacts(facts: FactInput[]) {
  const now = new Date().toISOString()
  for (const f of facts) {
    const record: QARecord = {
      id: f.id, question: f.question || null, answer: f.answer, askedAt: now, answeredAt: now,
      answeredBy: f.answeredBy ?? null, source: 'family', standing: Boolean(f.standing),
      remindAt: f.remindAt ?? null, expiresAt: f.expiresAt ?? null,
    }
    store.upsert(record)
    void matcher.warm(record)
  }
  console.log(`[facts] stored ${facts.length}`)
}

/**
 * D's CreaoStore seam (feat/creao-01-contracts): the only part of the store D's webhook router writes to.
 * Run output is untrusted, so facts from a run are validated like POST /facts and bad ones dropped.
 */
export const creaoStore = {
  async appendLogEntry(...a: Parameters<typeof store.appendLogEntry>) { store.appendLogEntry(...a) },
  async saveSummary(...a: Parameters<typeof store.saveSummary>) { store.saveSummary(...a) },
  async savePatterns(...a: Parameters<typeof store.savePatterns>) { store.savePatterns(...a) },
  async saveFacts(facts: FactInput[]) {
    const good = facts.filter(f => {
      const problem = factProblem(f)
      if (problem) console.warn(`[facts] dropped fact from Creao run (${problem})`)
      return !problem
    })
    saveFacts(good)
  },
  async getQaToday() { return store.todaysSpokenPairs() },
}
