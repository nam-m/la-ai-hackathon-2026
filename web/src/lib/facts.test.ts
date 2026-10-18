import { describe, expect, it } from 'vitest'
import { buildFact, emptyForm, expiryWords, formFromFact, sortFacts } from './facts'
import type { QARecord } from '../types'

const noon = new Date(2026, 9, 18, 12, 0)
const form = { ...emptyForm('Sarah'), question: ' Where is Mary? ', answer: 'At the store, back by 3' }
const record = (p: Partial<QARecord>): QARecord => ({
  id: 'f1', question: 'Q?', answer: 'A', askedAt: '', answeredAt: '2026-10-18T10:00:00Z', answeredBy: 'Sarah',
  source: 'family', standing: false, remindAt: null, expiresAt: null, ...p,
})

describe('buildFact', () => {
  it('requires question, answer and who', () => {
    expect(buildFact({ ...form, who: ' ' }, null, noon)).toEqual({ error: expect.stringContaining('Please fill in') })
  })
  it('trims text and expires tonight when no time is given', () => {
    const out = buildFact(form, null, noon)
    if (!('fact' in out)) throw new Error(out.error)
    expect(out.fact.question).toBe('Where is Mary?')
    expect(out.fact.answeredBy).toBe('Sarah')
    expect(new Date(out.fact.expiresAt!).getHours()).toBe(23)
    expect(out.fact.id).toMatch(/^fact_/)
  })
  it('uses the chosen time today, and rejects one already past', () => {
    const later = buildFact({ ...form, expiresTime: '15:00' }, 'fact_x', noon)
    if (!('fact' in later)) throw new Error(later.error)
    expect(later.fact.id).toBe('fact_x')
    expect(new Date(later.fact.expiresAt!).getHours()).toBe(15)
    expect(buildFact({ ...form, expiresTime: '09:00' }, null, noon)).toEqual({ error: expect.stringContaining('already passed') })
  })
  it('never expires an always-true fact', () => {
    const out = buildFact({ ...form, standing: true, expiresTime: '09:00' }, null, noon)
    expect('fact' in out && out.fact.expiresAt).toBeNull()
  })
})

describe('fact display', () => {
  it('describes expiry in plain words', () => {
    expect(expiryWords(record({ standing: true }), noon)).toBe('Always true')
    expect(expiryWords(record({}), noon)).toBe('Until tonight')
    expect(expiryWords(record({ expiresAt: new Date(2026, 9, 18, 23, 59).toISOString() }), noon)).toBe('Until tonight')
    expect(expiryWords(record({ expiresAt: new Date(2026, 9, 18, 15, 0).toISOString() }), noon)).toMatch(/^Until 3:00/)
  })
  it('round-trips an earlier expiry time into the form', () => {
    expect(formFromFact(record({ expiresAt: new Date(2026, 9, 18, 15, 0).toISOString() }), noon).expiresTime).toBe('15:00')
  })
  it('lists today’s facts before always-true ones, newest first', () => {
    const facts = [record({ id: 'home', standing: true }), record({ id: 'old', answeredAt: '2026-10-18T09:00:00Z' }), record({ id: 'new' })]
    expect(sortFacts(facts).map(f => f.id)).toEqual(['new', 'old', 'home'])
  })
})
