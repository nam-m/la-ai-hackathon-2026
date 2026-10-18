import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { Check, Clock, Sparkle, Sun, TrendDown, TrendFlat, TrendUp, Warn } from '../components/Icons'
import { greetingWord, time, WEARER } from '../lib/format'
import type { DashboardData } from '../lib/useDashboard'
import { barHeight, trendOf, worryColor } from '../lib/worry'
import type { Ask, Contradiction, DaySummary, QARecord, Repeated } from '../types'

const SUMMARY_POLL_MS = 5_000
const SUMMARY_WAIT_MS = 3 * 60_000

type Props = {
  data: DashboardData
  lastGood: string | null // when the data shown was last loaded
  name: string | null
  guard: <T>(call: () => Promise<T>) => Promise<T>
  onSummary: (s: DaySummary | null) => void
  onFix: (fact: QARecord, contradiction: Contradiction) => void
  onAddPlan: () => void
}

export function Today({ data, lastGood, name, guard, onSummary, onFix, onAddPlan }: Props) {
  const h = data.health
  const status = !h ? 'Unknown' : h.sessions === 0 ? 'Offline' : (h.paused ?? 0) >= h.sessions ? 'Paused' : 'Listening'
  return (
    <main className="page">
      <section className="greeting">
        <span className="avatar" aria-hidden="true">{WEARER[0]}</span>
        <div>
          <h1>{greetingWord()}{name ? `, ${name}` : ''}. Here’s {WEARER}’s day.</h1>
          <p className="status"><span className={`dot ${status.toLowerCase()}`} />{WEARER}’s glasses: <strong>{status}</strong></p>
        </div>
      </section>
      <div className="columns">
        <RepeatedQuestions data={data} lastGood={lastGood} onFix={onFix} />
        <aside className="side">
          <SummaryCard summary={data.summary} guard={guard} onSummary={onSummary} />
          <PlanCard facts={data.facts} onAddPlan={onAddPlan} />
        </aside>
      </div>
    </main>
  )
}

// ---- repeated questions ----

function RepeatedQuestions({ data, lastGood, onFix }: { data: DashboardData; lastGood: string | null; onFix: Props['onFix'] }) {
  const repeated = data.log?.repeated ?? []
  const toneOn = data.settings.toneAnalysis
  return (
    <section className="card questions" aria-labelledby="questions-title">
      <div className="card-head">
        <h2 id="questions-title">Questions {WEARER} asked again</h2>
        {lastGood && <span className="muted small">Updated {time(lastGood)}</span>}
      </div>
      {repeated.length === 0 ? (
        <div className="empty">
          <span className="icon-tile" aria-hidden="true"><Sun size={30} /></span>
          <h2>No repeated questions yet today.</h2>
          <p className="muted lead">{WEARER} is doing well. We’ll show any question {WEARER} asks more than once here.</p>
        </div>
      ) : (
        <>
          {repeated.map(q => (
            <Question key={q.question + q.times[0]} q={q} toneOn={toneOn}
              contradictions={(data.log?.contradictions ?? []).filter(c => q.times.includes(c.at))} onFix={onFix} />
          ))}
          {toneOn && (
            <div className="legend">
              <span className="mini-bars" aria-hidden="true"><i /><i /><i /></span><span>Taller bars mean {WEARER} sounded more worried.</span>
              <span className="no-reading" aria-hidden="true" /><span>No reading</span>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function Question({ q, toneOn, contradictions, onFix }: { q: Repeated; toneOn: boolean; contradictions: Contradiction[]; onFix: Props['onFix'] }) {
  // Older servers send times/worry only; treat those asks as unknown outcomes.
  const asks: Ask[] = q.asks ?? q.times.map((at, i) => ({ at, worry: q.worry[i] ?? null, shown: false, contradiction: false, answeredBy: null, source: null }))
  const trend = trendOf(asks.map(a => a.worry), toneOn)
  const TrendIcon = trend?.direction === 'up' ? TrendUp : trend?.direction === 'down' ? TrendDown : TrendFlat
  return (
    <section className="question">
      <div className="question-head">
        <div>
          <h3 className="question-text">“{q.question}”</h3>
          <p className="muted lead">Asked {q.count} times since {time(q.times[0])}</p>
        </div>
        {trend && <span className={`chip ${trend.kind}`}><TrendIcon />{trend.word}</span>}
      </div>
      <div className="asks">{asks.map((a, i) => <AskColumn key={`${i}-${a.at}`} ask={a} first={i === 0} toneOn={toneOn} />)}</div>
      {contradictions.map(c => <MismatchCallout key={c.questionEventId} c={c} onFix={onFix} />)}
    </section>
  )
}

function AskColumn({ ask, first, toneOn }: { ask: Ask; first: boolean; toneOn: boolean }) {
  const w = toneOn && typeof ask.worry === 'number' ? ask.worry : null
  const who = ask.answeredBy ?? 'someone'
  let pill: React.ReactNode, note: React.ReactNode
  if (ask.contradiction) {
    pill = <span className="pill worry"><Warn size={14} />Not shown</span>
    note = <span className="ask-note worry">Answers don’t match</span>
  } else if (ask.shown) {
    pill = <span className="pill good"><Check size={14} />Shown on glasses</span>
    note = <span className="ask-note">{ask.source === 'family' ? `From ${who}’s note` : `From what ${who} said`}</span>
  } else {
    pill = <span className="pill gray"><Clock size={14} />{first ? 'First time asked' : 'Not shown'}</span>
    note = <span className="ask-note">{ask.answeredBy ? `${ask.answeredBy} answered aloud` : 'No answer yet'}</span>
  }
  return (
    <div className="ask">
      <div className="bar-slot">
        {w == null
          ? <div className="bar none" title="No reading" />
          : <div className="bar" style={{ height: barHeight(w), background: worryColor(w) }} />}
      </div>
      <span className="ask-time">{time(ask.at)}</span>
      {pill}
      {note}
    </div>
  )
}

function MismatchCallout({ c, onFix }: { c: Contradiction; onFix: Props['onFix'] }) {
  return (
    <div className="callout">
      <span className="icon-tile amber round" aria-hidden="true"><Warn size={20} /></span>
      <div className="grow">
        <strong>At {time(c.at)} the glasses stayed quiet because two answers disagree.</strong>
        <span className="muted">
          {c.spoken?.answeredBy ?? 'Someone'} said: “{c.spoken?.answer ?? '…'}” · {c.fact?.answeredBy ?? 'The family'}’s note says: “{c.fact?.answer ?? '…'}”
        </span>
      </div>
      {c.fact && <button type="button" className="dark" onClick={() => onFix(c.fact!, c)}>Fix this fact</button>}
    </div>
  )
}

// ---- summary ----

const summaryText = (s: DaySummary | null) => (typeof s?.summary === 'string' ? s.summary : typeof s?.text === 'string' ? s.text : '')

function SummaryCard({ summary, guard, onSummary }: { summary: DaySummary | null; guard: Props['guard']; onSummary: Props['onSummary'] }) {
  const [waiting, setWaiting] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const alive = useRef(true)
  // Set it again on mount: React's dev StrictMode unmounts and remounts once, which would leave it false.
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const text = summaryText(summary)

  async function generate() {
    const before = JSON.stringify(summary)
    setWaiting(true)
    setNote('Writing today’s summary. This usually takes a minute or two.')
    try {
      await guard(api.generateSummary)
      const until = Date.now() + SUMMARY_WAIT_MS
      while (alive.current && Date.now() < until) {
        await new Promise(r => setTimeout(r, SUMMARY_POLL_MS))
        const next = await guard(api.summary)
        if (JSON.stringify(next) !== before) { onSummary(next); setNote(null); return }
      }
      setNote('The summary is taking longer than usual. It will appear here when it’s ready.')
    } catch {
      setNote('Couldn’t start a summary right now. Try again in a minute.')
    } finally {
      if (alive.current) setWaiting(false)
    }
  }

  const idleNote = text
    ? (summary?.generatedAt ? `Last written at ${time(summary.generatedAt)}` : '')
    : 'No summary yet today. It’s written at 8 PM, or now if you ask.'
  return (
    <section className="card" aria-labelledby="summary-title">
      <h2 id="summary-title">Today’s summary</h2>
      <p className="ai-label"><Sparkle />Written by AI from today’s conversations</p>
      {text && <p className="summary">{text}</p>}
      {(note ?? idleNote) && <p className="muted small" role="status">{note ?? idleNote}</p>}
      <button type="button" className="primary wide" disabled={waiting} onClick={generate}><Sparkle size={18} />Generate today’s summary</button>
    </section>
  )
}

// ---- today's plan: facts that clear tonight ----

function PlanCard({ facts, onAddPlan }: { facts: QARecord[]; onAddPlan: () => void }) {
  const plan = facts.filter(f => !f.standing && f.question)
  return (
    <section className="card" aria-labelledby="plan-title">
      <h2 id="plan-title" className="h3">Today’s plan</h2>
      <ul className="plan">
        {plan.length === 0 && <li className="muted">Nothing planned yet today.</li>}
        {plan.map(f => (
          <li key={f.id}><strong>{f.answer}</strong><span className="muted small">When {WEARER} asks “{f.question}” · from {f.answeredBy ?? 'the family'}</span></li>
        ))}
      </ul>
      <button type="button" className="text-link" onClick={onAddPlan}>Add to today’s plan →</button>
    </section>
  )
}
