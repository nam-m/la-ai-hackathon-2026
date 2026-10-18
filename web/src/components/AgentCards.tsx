import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { changed, factFromProposal, plain } from '../lib/agents'
import { time, WEARER } from '../lib/format'
import type { CareRun, OpenQuestionsResult, PatternsResult, QARecord } from '../types'
import { Sparkle } from './Icons'
import { useToast } from './Toast'

// The CREAO agents behind the family app. They run on their own (the server schedules them); the cards show what the
// agents found, and "Check now" / "Update now" start a run early. A run takes about a minute, so those buttons poll
// for the saved result. Nothing an agent returns changes what the glasses say: a person approves first.

const POLL_MS = 4_000
const WAIT_MS = 3 * 60_000
type Guard = <T>(call: () => Promise<T>) => Promise<T>

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const busyMessage = (e: unknown) =>
  /already running/.test((e as Error).message) ? 'It’s already working on this. Check back in a minute.' : 'Couldn’t start that right now. Try again in a minute.'

/** True while mounted. Set again on mount: React's dev StrictMode unmounts and remounts once. */
function useAlive() {
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  return alive
}

/** Polls `read` every few seconds until it returns true, the card goes away, or three minutes pass. */
async function pollUntil(alive: React.MutableRefObject<boolean>, read: () => Promise<boolean>) {
  const until = Date.now() + WAIT_MS
  while (alive.current && Date.now() < until) {
    await sleep(POLL_MS)
    if (!alive.current) return false
    if (await read()) return true
  }
  return false
}

// ---- Open Questions: what the glasses could not answer ----

export function OpenQuestionsCard({ guard, onAnswer }: { guard: Guard; onAnswer: (question: string) => void }) {
  const alive = useAlive()
  const [result, setResult] = useState<OpenQuestionsResult | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => { api.openQuestions().then(r => alive.current && setResult(r)).catch(() => {}) }, [alive])

  async function run() {
    const before = result?.generatedAt
    setWaiting(true)
    setNote('Looking through the week. This usually takes a minute or two.')
    try {
      await guard(api.findOpenQuestions)
      const got = await pollUntil(alive, async () => {
        const next = await guard(api.openQuestions)
        if (next && changed(next.generatedAt, before)) { setResult(next); return true }
        return false
      })
      if (alive.current) setNote(got ? null : 'This is taking longer than usual. The result will appear here when it’s ready.')
    } catch (e) {
      if (alive.current) setNote(busyMessage(e))
    } finally {
      if (alive.current) setWaiting(false)
    }
  }

  const items = result?.open_questions ?? []
  return (
    <section className="card" aria-labelledby="oq-title">
      <h2 id="oq-title" className="h3">Questions the glasses couldn’t answer</h2>
      <p className="ai-label"><Sparkle />Found by an AI agent from the week’s conversations</p>
      {result && items.length === 0 && <p className="muted">Nothing is waiting for an answer. Every repeated question has one.</p>}
      <ul className="plan">
        {items.map(q => (
          <li key={q.cluster_id}>
            <strong>{q.canonical_question}</strong>
            <span className="muted small">Asked {q.count} times{q.distinct_times_of_day ? `, at ${q.distinct_times_of_day} different times of day` : ''}. No answer saved yet.</span>
            <button type="button" className="text-link" onClick={() => onAnswer(q.canonical_question)}>Add an answer →</button>
          </li>
        ))}
      </ul>
      {(note ?? (result?.generatedAt ? `Last checked at ${time(result.generatedAt)}` : 'Not checked yet today.')) && (
        <p className="muted small" role="status">{note ?? (result?.generatedAt ? `Last checked at ${time(result.generatedAt)}` : 'Not checked yet today.')}</p>
      )}
      <button type="button" className="secondary wide" disabled={waiting} onClick={run}><Sparkle size={18} />Check now</button>
    </section>
  )
}

// ---- Pattern finder: what repeats across days ----

export function PatternsCard({ guard }: { guard: Guard }) {
  const alive = useAlive()
  const [result, setResult] = useState<PatternsResult | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => { api.patterns().then(r => alive.current && setResult(r)).catch(() => {}) }, [alive])

  async function run() {
    const before = result?.generatedAt
    setWaiting(true)
    setNote('Comparing the days. This usually takes a minute or two.')
    try {
      await guard(api.findPatterns)
      const got = await pollUntil(alive, async () => {
        const next = await guard(api.patterns)
        if (next && changed(next.generatedAt, before)) { setResult(next); return true }
        return false
      })
      if (alive.current) setNote(got ? null : 'This is taking longer than usual. The result will appear here when it’s ready.')
    } catch (e) {
      if (alive.current) setNote(busyMessage(e))
    } finally {
      if (alive.current) setWaiting(false)
    }
  }

  const items = result?.patterns ?? []
  const idle = result?.generatedAt ? `Last checked at ${time(result.generatedAt)}` : 'Not checked yet today.'
  return (
    <section className="card" aria-labelledby="pat-title">
      <h2 id="pat-title" className="h3">What repeats across the week</h2>
      <p className="ai-label"><Sparkle />Counted by an AI agent, never guessed</p>
      {result?.insufficient_data && <p className="muted">Not enough days yet to say what repeats.</p>}
      <ul className="plan">
        {items.map(p => (
          <li key={p.cluster}>
            <strong>{p.cluster}</strong>
            <span className="muted small">
              On {p.days_seen} days{p.total_count ? `, ${p.total_count} times` : ''}{p.time_window ? `, mostly between ${p.time_window}` : ''}.
            </span>
          </li>
        ))}
      </ul>
      <p className="muted small" role="status">{note ?? idle}</p>
      <button type="button" className="secondary wide" disabled={waiting} onClick={run}><Sparkle size={18} />Update now</button>
    </section>
  )
}

// ---- Care assistant: change what the glasses say, with a person's approval ----

type Props = { facts: QARecord[]; name: string | null; guard: Guard; refresh: () => Promise<void> }

export function CareAssistantCard({ facts, name, guard, refresh }: Props) {
  const alive = useAlive()
  const toast = useToast()
  const [role, setRole] = useState<'caregiver' | 'clinician'>('caregiver')
  const [request, setRequest] = useState('')
  const [waiting, setWaiting] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [run, setRun] = useState<CareRun | null>(null)
  const [saving, setSaving] = useState(false)

  async function ask(e: React.FormEvent) {
    e.preventDefault()
    if (!request.trim()) return setNote('Write what should change first.')
    setWaiting(true)
    setRun(null)
    setNote('The assistant is reading your request. This usually takes a minute.')
    try {
      const { runId } = await guard(() => api.askCare(role, request.trim()))
      let last: CareRun | null = null
      await pollUntil(alive, async () => {
        last = await guard(() => api.careRun(runId))
        return last.status !== 'running'
      })
      if (!alive.current) return
      const done = last as CareRun | null
      if (done && done.status !== 'running') { setRun(done); setNote(null) } else setNote('This is taking longer than usual. Try again in a minute.')
    } catch (err) {
      if (alive.current) setNote(busyMessage(err))
    } finally {
      if (alive.current) setWaiting(false)
    }
  }

  const result = run?.status === 'done' ? run.result : undefined
  const built = result && result.role === 'caregiver' ? factFromProposal(result, facts, name ?? '') : null

  async function approve() {
    if (!built || 'error' in built) return
    setSaving(true)
    try {
      await guard(() => api.saveFacts([built.fact]))
      toast(`Saved. ${WEARER}’s glasses will say this until ${time(built.fact.expiresAt!)} on ${new Date(built.fact.expiresAt!).toLocaleDateString([], { weekday: 'long' })}.`)
      setRun(null)
      setRequest('')
      await refresh()
    } catch {
      setNote('Couldn’t save that right now. Nothing changed. Try again in a minute.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="card" aria-labelledby="care-title">
      <h2 id="care-title" className="h3">Ask the care assistant</h2>
      <p className="ai-label"><Sparkle />An AI agent proposes. You approve before the glasses change.</p>
      <form className="care-form" onSubmit={ask} noValidate>
        <div className="chips" role="group" aria-label="Who is asking">
          <button type="button" className="secondary role-btn" aria-pressed={role === 'caregiver'} onClick={() => setRole('caregiver')}>Family</button>
          <button type="button" className="secondary role-btn" aria-pressed={role === 'clinician'} onClick={() => setRole('clinician')}>Care team</button>
        </div>
        <label htmlFor="care-request">{role === 'caregiver' ? `What should ${WEARER} hear?` : 'What should be tuned?'}</label>
        <textarea id="care-request" rows={3} value={request} onChange={e => setRequest(e.target.value)}
          placeholder={role === 'caregiver' ? 'I’m visiting Thursday at 3' : 'Only raise a question after 5 asks within 60 minutes'} />
        <button type="submit" className="primary wide" disabled={waiting}><Sparkle size={18} />Ask the assistant</button>
      </form>
      {note && <p className="muted small" role="status">{note}</p>}

      {run?.status === 'failed' && <p className="field-error" role="alert">The assistant couldn’t finish that. Nothing changed. Try again in a minute.</p>}

      {built && 'fact' in built && (
        <div className="proposal" role="region" aria-label="Proposed change">
          <p className="muted small">The glasses would say:</p>
          <p className="summary">“{built.fact.answer}”</p>
          <p className="muted small">
            When {WEARER} asks “{built.fact.question}”{built.replaces ? `. Replaces: “${built.replaces.answer}”` : ''}. Stops being true {new Date(built.fact.expiresAt!).toLocaleString([], { weekday: 'long', hour: 'numeric', minute: '2-digit' })}.
          </p>
          <div className="form-actions">
            <button type="button" className="primary wide" disabled={saving} onClick={approve}>Approve and save</button>
            <button type="button" className="secondary" disabled={saving} onClick={() => setRun(null)}>Not now</button>
          </div>
        </div>
      )}
      {built && 'error' in built && result?.role === 'caregiver' && <p className="muted" role="status">{built.error}</p>}

      {result?.role === 'clinician' && (
        <div className="proposal" role="region" aria-label="Suggested setting">
          {result.rejected_reason ? <p className="muted">{result.rejected_reason}</p> : (
            <>
              {result.settings_change && <p><strong>{result.settings_change.key.replace(/_/g, ' ')}</strong>: {String(result.settings_change.from)} → {String(result.settings_change.to)}</p>}
              {result.preview && (
                <p className="muted small">Before: {plain(result.preview.before)}. After: {plain(result.preview.after)}.</p>
              )}
              {result.note && <p className="muted small">{result.note}</p>}
              <p className="muted small">This is a preview only. The app doesn’t apply it automatically; it’s for the care team to decide.</p>
            </>
          )}
        </div>
      )}
    </section>
  )
}
