import { useState } from 'react'
import { api } from '../api'
import { Wave } from '../components/Icons'
import { useToast } from '../components/Toast'
import { WEARER } from '../lib/format'
import type { Settings as SettingsData } from '../types'

type Props = {
  settings: SettingsData
  guard: <T>(call: () => Promise<T>) => Promise<T>
  onChange: (s: SettingsData) => void
  onSignOut: () => void
}

export function Settings({ settings, guard, onChange, onSignOut }: Props) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  async function setTone(on: boolean) {
    setBusy(true)
    try {
      onChange(await guard(() => api.saveSettings({ toneAnalysis: on })))
    } catch {
      toast('Couldn’t change that right now. Try again in a minute.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="page narrow">
      <section className="intro">
        <h1>Settings</h1>
        <p className="muted lead">Choose what Rewind keeps track of for {WEARER}.</p>
      </section>
      <section className="card setting">
        <span className="icon-tile amber" aria-hidden="true"><Wave size={24} /></span>
        <div className="grow">
          <h2 className="h3" id="tone-title">Estimated tone of voice</h2>
          <p className="muted">Listens to how {WEARER} asks questions so you can see when {WEARER} sounds worried. Only shown to family. Never changes what the glasses say.</p>
        </div>
        <label className="switch">
          <input type="checkbox" aria-labelledby="tone-title" checked={settings.toneAnalysis} disabled={busy} onChange={e => setTone(e.target.checked)} />
          <span aria-hidden="true" />
          <span className="switch-word">{settings.toneAnalysis ? 'On' : 'Off'}</span>
        </label>
      </section>
      <button type="button" className="text-link center" onClick={onSignOut}>Sign out of this browser</button>
    </main>
  )
}
