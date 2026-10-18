import { useCallback, useState } from 'react'
import { getKey, prefs, setKey } from './api'
import { Header } from './components/Header'
import { NoSignal, Warn } from './components/Icons'
import { SignIn } from './components/SignIn'
import { ToastProvider } from './components/Toast'
import { time, WEARER } from './lib/format'
import { useDashboard } from './lib/useDashboard'
import { useHashTab } from './lib/useHashTab'
import { Facts, type Draft } from './pages/Facts'
import { Settings } from './pages/Settings'
import { Today } from './pages/Today'
import type { Contradiction, QARecord } from './types'

const NAME = 'rewind.name' // the family member's name, remembered from the last "Who's saying it"

export function App() {
  // 0 = signed out; bumped on each sign-in so data loading restarts with the new key.
  const [session, setSession] = useState(() => (getKey() ? 1 : 0))
  const [tab, go] = useHashTab()
  const [name, setName] = useState(() => prefs.get(NAME))
  const [draft, setDraft] = useState<Draft | null>(null)
  const dash = useDashboard(session)

  const fix = useCallback((fact: QARecord, contradiction: Contradiction) => {
    setDraft(d => ({ n: (d?.n ?? 0) + 1, fact, contradiction }))
    go('facts')
  }, [go])
  const addPlan = useCallback(() => {
    setDraft(d => ({ n: (d?.n ?? 0) + 1, question: 'What’s the plan today?' }))
    go('facts')
  }, [go])
  const saved = useCallback((who: string) => {
    if (!who) return
    prefs.set(NAME, who)
    setName(who)
  }, [])
  const signOut = () => { setKey(null); setSession(0); go('today') }

  if (session === 0 || dash.unauthorized) {
    return <SignIn failed={session > 0 && dash.unauthorized} onSignedIn={() => setSession(s => s + 1)} />
  }

  const { data } = dash
  return (
    <ToastProvider>
      <Header tab={tab} name={name} />
      {dash.offline && (
        <div className="banner" role="status">
          <span className="icon-tile gray" aria-hidden="true"><NoSignal size={18} /></span>
          <div className="grow">
            <strong>Can’t reach {WEARER}’s glasses right now</strong>
            <span className="muted">{dash.lastGood ? `Showing what we had at ${time(dash.lastGood)}. ` : ''}We’ll keep trying.</span>
          </div>
          <button type="button" className="secondary" onClick={dash.refresh}>Try again</button>
        </div>
      )}
      {dash.loaded && dash.error && !dash.offline && (
        <div className="banner" role="status">
          <span className="icon-tile gray" aria-hidden="true"><Warn size={18} /></span>
          <div className="grow">
            <strong>Couldn’t refresh {WEARER}’s day</strong>
            <span className="muted">{dash.lastGood ? `Showing what we had at ${time(dash.lastGood)}. ` : ''}({dash.error})</span>
          </div>
          <button type="button" className="secondary" onClick={dash.refresh}>Try again</button>
        </div>
      )}
      {/* Never show empty screens before the first load: "no repeated questions" would be a false all-clear. */}
      {!dash.loaded ? (
        <main className="page">
          {dash.error && !dash.offline ? (
            <section className="card load-error" role="alert">
              <h2 className="h3">Couldn’t load {WEARER}’s day</h2>
              <p className="muted">The server answered, but something went wrong ({dash.error}). It may need updating to match this app.</p>
              <button type="button" className="secondary" onClick={dash.refresh}>Try again</button>
            </section>
          ) : (
            <p className="muted lead" role="status">{dash.offline ? 'Waiting for the server…' : 'Loading…'}</p>
          )}
        </main>
      ) : tab === 'today' ? (
        <Today data={data} lastGood={dash.lastGood} name={name} guard={dash.guard} onSummary={summary => dash.patch({ summary })} onFix={fix} onAddPlan={addPlan} />
      ) : tab === 'facts' ? (
        <Facts facts={data.facts} contradictions={data.log?.contradictions ?? []} draft={draft} name={name}
          guard={dash.guard} refresh={dash.refresh} onSaved={saved} />
      ) : (
        <Settings settings={data.settings} guard={dash.guard} onChange={settings => dash.patch({ settings })} onSignOut={signOut} />
      )}
    </ToastProvider>
  )
}
