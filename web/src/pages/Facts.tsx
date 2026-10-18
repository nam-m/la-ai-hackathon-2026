import { useEffect, useRef, useState } from 'react'
import { api, Offline } from '../api'
import { Clock, Edit, Plus, Trash, Warn } from '../components/Icons'
import { useToast } from '../components/Toast'
import { buildFact, emptyForm, expiryWords, formFromFact, sortFacts, toFactInput, type FactForm } from '../lib/facts'
import { time, WEARER } from '../lib/format'
import type { Contradiction, QARecord } from '../types'

/** Something another tab asked the form to show: a fact to fix, or a quick-add question. Bump `n` to re-apply. */
export type Draft = { n: number; fact?: QARecord; contradiction?: Contradiction; question?: string }

type Props = {
  facts: QARecord[]
  contradictions: Contradiction[]
  draft: Draft | null
  name: string | null
  guard: <T>(call: () => Promise<T>) => Promise<T>
  refresh: () => Promise<void>
  onSaved: (who: string) => void
}

const QUICK = ['Who’s visiting today?', 'What’s the plan today?']

export function Facts({ facts, contradictions, draft, name, guard, refresh, onSaved }: Props) {
  const toast = useToast()
  const [form, setForm] = useState<FactForm>(() => emptyForm(name ?? ''))
  const [editing, setEditing] = useState<QARecord | null>(null)
  const [mismatch, setMismatch] = useState<Contradiction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const answerRef = useRef<HTMLInputElement>(null)

  const set = <K extends keyof FactForm>(k: K, v: FactForm[K]) => setForm(f => ({ ...f, [k]: v }))
  function reset(who = name ?? '') {
    setForm(emptyForm(who))
    setEditing(null)
    setMismatch(null)
    setError(null)
  }
  function startEdit(f: QARecord, c?: Contradiction) {
    setForm(formFromFact(f))
    setEditing(f)
    setMismatch(c ?? null)
    setError(null)
    window.scrollTo(0, 0)
    setTimeout(() => answerRef.current?.focus())
  }
  function quickAdd(question: string) {
    reset()
    setForm({ ...emptyForm(name ?? ''), question })
    setTimeout(() => answerRef.current?.focus())
  }

  // Apply requests from the Today tab (Fix this fact, Add to today's plan).
  useEffect(() => {
    if (!draft) return
    if (draft.fact) startEdit(draft.fact, draft.contradiction)
    else if (draft.question) quickAdd(draft.question)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.n])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    const built = buildFact(form, editing?.id ?? null)
    if ('error' in built) return setError(built.error)
    setSaving(true)
    try {
      await guard(() => api.saveFacts([built.fact]))
      onSaved(built.fact.answeredBy ?? '')
      reset(built.fact.answeredBy ?? '') // `name` updates on the next render; keep who just saved in the form
      toast(`Saved. ${WEARER}’s glasses can answer this now.`)
      await refresh()
    } catch (err) {
      setError(err instanceof Offline ? 'Couldn’t reach the server. Your fact wasn’t saved yet.' : `Couldn’t save: ${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  async function remove(f: QARecord) {
    try {
      await guard(() => api.deleteFact(f.id))
      if (editing?.id === f.id) reset()
      toast(f.question ? `Removed “${f.question}”` : 'Removed the reminder', {
        label: 'Undo',
        run: async () => { await guard(() => api.saveFacts([toFactInput(f)])); toast('Put it back.'); await refresh() },
      })
      await refresh()
    } catch {
      toast('Couldn’t remove that right now. Try again in a minute.')
    }
  }

  const mismatchByFact = new Map(contradictions.filter(c => c.fact).map(c => [c.fact!.id, c]))
  const sorted = sortFacts(facts)

  return (
    <main className="page">
      <section className="intro">
        <h1>Facts</h1>
        <p className="muted lead">{WEARER}’s glasses can answer these questions, word for word as you write them.</p>
      </section>
      <div className="columns">
        <div className="form-column">
          <form id="fact-form" className="card" noValidate onSubmit={save}>
            <h2>{editing ? 'Edit this fact' : 'Add a fact'}</h2>
            {mismatch && (
              <p className="mismatch-note">
                {mismatch.spoken?.answeredBy ?? 'Someone'} told {WEARER} “{mismatch.spoken?.answer ?? '…'}” at {time(mismatch.at)}. Update the answer so they match.
              </p>
            )}
            <label htmlFor="f-question">When {WEARER} asks</label>
            <input id="f-question" placeholder="Where is Mary?" value={form.question} onChange={e => set('question', e.target.value)} />
            <label htmlFor="f-answer">The glasses will say</label>
            <input id="f-answer" ref={answerRef} placeholder="At the store, back by 3" value={form.answer} onChange={e => set('answer', e.target.value)} />
            <label htmlFor="f-who">Who’s saying it</label>
            <input id="f-who" placeholder="Sarah" value={form.who} onChange={e => set('who', e.target.value)} />
            <div className="expiry">
              <div className="switch-row">
                <div><strong>Always true</strong><span className="muted small">Turn on for things that don’t change, like {WEARER}’s address.</span></div>
                <label className="switch">
                  <input type="checkbox" checked={form.standing} onChange={e => set('standing', e.target.checked)} />
                  <span aria-hidden="true" /><span className="sr-only">Always true</span>
                </label>
              </div>
              {!form.standing && (
                <div className="switch-row bordered">
                  <label htmlFor="f-expires"><strong>Stops being true at</strong><span className="muted small">Leave empty for tonight.</span></label>
                  <input id="f-expires" type="time" value={form.expiresTime} onChange={e => set('expiresTime', e.target.value)} />
                </div>
              )}
            </div>
            {error && <p className="field-error" role="alert">{error}</p>}
            <div className="form-actions">
              <button type="submit" className="primary wide" disabled={saving}>{editing ? 'Save changes' : 'Save'}</button>
              {editing && <button type="button" className="secondary" onClick={() => reset()}>Cancel</button>}
            </div>
          </form>
          <section className="card" aria-labelledby="quick-title">
            <h2 id="quick-title" className="h3">Quick add for today</h2>
            <p className="muted small">These clear themselves tonight.</p>
            <div className="chips">
              {QUICK.map(q => <button key={q} type="button" className="secondary" onClick={() => quickAdd(q)}><Plus size={14} />{q}</button>)}
            </div>
          </section>
        </div>

        <section className="fact-column" aria-labelledby="known-title">
          <div className="list-head">
            <h2 id="known-title">What {WEARER}’s glasses know</h2>
            <span className="muted">{sorted.length} {sorted.length === 1 ? 'fact' : 'facts'}</span>
          </div>
          <div id="fact-list">
            {sorted.length === 0 && <p className="card muted">No facts yet. Add one, and {WEARER}’s glasses can answer it right away.</p>}
            {sorted.map(f => {
              const c = mismatchByFact.get(f.id)
              return (
                <article key={f.id} className={`card fact${c ? ' mismatch' : ''}`}>
                  <div className="grow">
                    <span className="muted">{f.question ? `When ${WEARER} asks “${f.question}”` : 'Reminder'}</span>
                    <span className="fact-answer">{f.answer}</span>
                    <div className="fact-meta"><span>{f.answeredBy ?? 'Family'}</span><span><Clock size={14} />{expiryWords(f)}</span></div>
                    {c && (
                      <span className="pill worry multiline"><Warn size={14} />
                        Doesn’t match what {c.spoken?.answeredBy ?? 'someone'} said at {time(c.at)}: “{c.spoken?.answer ?? '…'}”
                      </span>
                    )}
                  </div>
                  <div className="fact-actions">
                    {f.question && <button type="button" className="secondary" onClick={() => startEdit(f, c)}><Edit />Edit</button>}
                    <button type="button" className="secondary" onClick={() => remove(f)}><Trash />Delete</button>
                  </div>
                </article>
              )
            })}
          </div>
        </section>
      </div>
    </main>
  )
}
