import { useState } from 'react'
import { api, setKey, Unauthorized } from '../api'
import { WEARER } from '../lib/format'
import { Brand } from './Header'

/** Asked once per browser. The family key is the server's FACTS_SECRET. */
export function SignIn({ failed, onSignedIn }: { failed: boolean; onSignedIn: () => void }) {
  const [key, setValue] = useState('')
  const [error, setError] = useState<string | null>(failed ? 'That key didn’t work. Check it and try again.' : null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setKey(key.trim())
    try {
      await api.settings()
      onSignedIn()
    } catch (err) {
      setError(err instanceof Unauthorized ? 'That key didn’t work. Check it and try again.' : 'Couldn’t reach the server. Try again in a moment.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="sign-in">
      <form className="card sign-in-card" onSubmit={submit}>
        <Brand />
        <h1>Welcome</h1>
        <p className="muted">Enter the family key to see {WEARER}’s day.</p>
        <label htmlFor="key-input">Family key</label>
        <input id="key-input" type="password" autoComplete="current-password" required autoFocus value={key} onChange={e => setValue(e.target.value)} />
        {error && <p className="field-error" role="alert">{error}</p>}
        <button type="submit" className="primary" disabled={busy}>Continue</button>
      </form>
    </main>
  )
}
