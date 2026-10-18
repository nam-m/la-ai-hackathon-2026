import type { CareResult, FactInput, QARecord } from '../types'

/** True when two reads differ, ignoring key order noise: used to see that a new agent result has arrived. */
export const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b)

/**
 * Turns a caregiver proposal from the Care assistant into the fact a person can approve. Mirrors
 * care-agents/approve-proposal.mjs: only a clean replace_fact proposal with wording, a question and a future
 * valid-until time passes. The fact is standing, so it lasts until valid-until (the server enforces expiresAt),
 * not just until tonight. Replaces the named fact when it exists, otherwise adds a new one.
 */
export function factFromProposal(
  result: CareResult,
  facts: QARecord[],
  who: string,
  now = new Date(),
): { fact: FactInput; replaces: QARecord | null } | { error: string } {
  if (result.rejected_reason) return { error: result.rejected_reason }
  if (result.clarifying_question) return { error: result.clarifying_question }
  if (result.role !== 'caregiver') return { error: 'Only a caregiver request can change what the glasses say.' }
  const p = result.proposal
  if (!p || p.action !== 'replace_fact') return { error: 'The assistant did not propose a change to a fact.' }
  const question = p.question?.trim(), answer = p.answer_wording?.trim()
  if (!question || !answer) return { error: 'The proposal is missing its question or wording.' }
  const until = p.valid_until ? new Date(p.valid_until) : null
  if (!until || Number.isNaN(until.getTime())) return { error: 'The proposal has no valid-until time.' }
  if (until <= now) return { error: 'That time has already passed. Ask again with a later time.' }
  const replaces = p.replaces_fact_id ? facts.find(f => f.id === p.replaces_fact_id && f.source === 'family') ?? null : null
  return {
    replaces,
    fact: {
      id: replaces?.id ?? `fact_${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      question,
      answer,
      answeredBy: who.trim() || 'The family',
      standing: true,
      remindAt: null,
      expiresAt: until.toISOString(),
    },
  }
}

/** "repeat_threshold_count: 3" style text for a clinician's before/after preview. Short on purpose. */
export function plain(value: unknown): string {
  if (value == null) return 'none'
  if (typeof value !== 'object') return String(value)
  const entries = Object.entries(value as Record<string, unknown>)
  return entries.map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(', ')
}
