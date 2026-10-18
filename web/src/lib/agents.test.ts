import { describe, expect, it } from 'vitest'
import type { CareResult, QARecord } from '../types'
import { changed, factFromProposal, plain } from './agents'

const now = new Date('2026-10-18T17:00:00')
const fact: QARecord = { id: 'f1', question: 'When is Sarah coming?', answer: 'Sunday', askedAt: '', answeredAt: '', answeredBy: 'Sarah', source: 'family', standing: true }
const good: CareResult = {
  role: 'caregiver',
  proposal: { action: 'replace_fact', replaces_fact_id: 'f1', question: 'When is Sarah coming?', answer_wording: 'Your daughter Sarah is visiting Thursday, October 22 at 3 PM.', valid_until: '2026-10-22T18:00:00' },
}

describe('factFromProposal', () => {
  it('builds a standing fact that replaces the named fact and lasts until valid-until', () => {
    const out = factFromProposal(good, [fact], 'Sarah', now)
    if ('error' in out) throw new Error(out.error)
    expect(out.fact).toMatchObject({ id: 'f1', question: 'When is Sarah coming?', answeredBy: 'Sarah', standing: true, remindAt: null })
    expect(out.fact.expiresAt).toBe(new Date('2026-10-22T18:00:00').toISOString())
    expect(out.replaces?.id).toBe('f1')
  })
  it('adds a new fact when the named one is gone or not a family fact', () => {
    const out = factFromProposal(good, [{ ...fact, source: 'spoken' }], '', now)
    if ('error' in out) throw new Error(out.error)
    expect(out.fact.id).not.toBe('f1')
    expect(out.replaces).toBeNull()
    expect(out.fact.answeredBy).toBe('The family')
  })
  it('refuses clarifying questions, refusals, clinician output, other actions and bad times', () => {
    expect(factFromProposal({ ...good, clarifying_question: 'What time?' }, [fact], 'S', now)).toEqual({ error: 'What time?' })
    expect(factFromProposal({ ...good, rejected_reason: 'Not allowed' }, [fact], 'S', now)).toEqual({ error: 'Not allowed' })
    expect('error' in factFromProposal({ ...good, role: 'clinician' }, [fact], 'S', now)).toBe(true)
    expect('error' in factFromProposal({ role: 'caregiver', proposal: { ...good.proposal, action: 'delete_fact' } }, [fact], 'S', now)).toBe(true)
    expect('error' in factFromProposal({ ...good, proposal: { ...good.proposal, answer_wording: ' ' } }, [fact], 'S', now)).toBe(true)
    expect('error' in factFromProposal({ ...good, proposal: { ...good.proposal, valid_until: 'soon' } }, [fact], 'S', now)).toBe(true)
    expect('error' in factFromProposal({ ...good, proposal: { ...good.proposal, valid_until: '2026-10-18T09:00:00' } }, [fact], 'S', now)).toBe(true)
    expect('error' in factFromProposal({ role: 'caregiver' }, [fact], 'S', now)).toBe(true)
  })
})

describe('helpers', () => {
  it('changed compares by content', () => {
    expect(changed({ a: 1 }, { a: 1 })).toBe(false)
    expect(changed(null, { a: 1 })).toBe(true)
  })
  it('plain flattens a settings preview to words', () => {
    expect(plain({ repeat_threshold_count: 3, groups: 10 })).toBe('repeat threshold count: 3, groups: 10')
    expect(plain(null)).toBe('none')
  })
})
