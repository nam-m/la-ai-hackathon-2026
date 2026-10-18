import type { FactInput, QARecord } from '../types'
import { endOfToday, time } from './format'

export type FactForm = { question: string; answer: string; who: string; standing: boolean; expiresTime: string /* "HH:MM" or "" */ }

export const emptyForm = (who = ''): FactForm => ({ question: '', answer: '', who, standing: false, expiresTime: '' })

export function formFromFact(f: QARecord, now = new Date()): FactForm {
  const exp = f.expiresAt ? new Date(f.expiresAt) : null
  return {
    question: f.question ?? '', answer: f.answer, who: f.answeredBy ?? '', standing: f.standing,
    expiresTime: exp && exp < endOfToday(now) ? exp.toTimeString().slice(0, 5) : '',
  }
}

/** Validates the form and builds the POST /facts item. An empty time means tonight: every fact needs an expiry. */
export function buildFact(form: FactForm, id: string | null, now = new Date()): { fact: FactInput } | { error: string } {
  const question = form.question.trim(), answer = form.answer.trim(), who = form.who.trim()
  if (!question || !answer || !who) return { error: 'Please fill in the question, the answer and who’s saying it.' }
  let expiresAt: string | null = null
  if (!form.standing) {
    const d = form.expiresTime ? new Date(now) : endOfToday(now)
    if (form.expiresTime) {
      const [h, m] = form.expiresTime.split(':').map(Number)
      d.setHours(h, m, 0, 0)
    }
    if (d <= now) return { error: 'That time has already passed today. Pick a later time, or leave it empty for tonight.' }
    expiresAt = d.toISOString()
  }
  return {
    fact: {
      id: id ?? `fact_${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      question, answer, answeredBy: who, standing: form.standing, remindAt: null, expiresAt,
    },
  }
}

export const toFactInput = (r: QARecord): FactInput => ({
  id: r.id, question: r.question, answer: r.answer, answeredBy: r.answeredBy, standing: r.standing,
  remindAt: r.remindAt ?? null, expiresAt: r.expiresAt ?? null,
})

export function expiryWords(f: QARecord, now = new Date()) {
  if (f.remindAt) return `Reminder at ${time(f.remindAt)}`
  if (f.standing) return 'Always true'
  if (f.expiresAt && new Date(f.expiresAt) < endOfToday(now)) return `Until ${time(f.expiresAt)}`
  return 'Until tonight'
}

/** Permanent facts last, newest first within each group. */
export const sortFacts = (facts: QARecord[]) =>
  [...facts].sort((a, b) => Number(a.standing) - Number(b.standing) || b.answeredAt.localeCompare(a.answeredAt))
