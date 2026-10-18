import { useCallback, useEffect, useRef, useState } from 'react'
import { api, Offline, Unauthorized } from '../api'
import type { DaySummary, Health, LogToday, QARecord, Settings } from '../types'

const POLL_MS = 15_000

export type DashboardData = {
  health: Health | null
  log: LogToday | null
  facts: QARecord[]
  summary: DaySummary | null
  settings: Settings
}

const initial: DashboardData = { health: null, log: null, facts: [], summary: null, settings: { toneAnalysis: true } }

/** Loads everything the three tabs show and refreshes it every 15 s. `session` 0 = signed out; a new value restarts loading. */
export function useDashboard(session: number) {
  const [data, setData] = useState<DashboardData>(initial)
  const [loaded, setLoaded] = useState(false)
  const [unauthorized, setUnauthorized] = useState(false)
  const [offline, setOffline] = useState(false)
  const [lastGood, setLastGood] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null) // last load failure that wasn't offline or a bad key
  const busy = useRef(false)

  /** Wraps any call: tracks offline and signed-out states the same way everywhere. */
  const guard = useCallback(async <T,>(call: () => Promise<T>): Promise<T> => {
    try {
      const out = await call()
      setOffline(false)
      return out
    } catch (e) {
      if (e instanceof Offline) setOffline(true)
      if (e instanceof Unauthorized) setUnauthorized(true)
      throw e
    }
  }, [])

  const refresh = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    try {
      // Health and the summary are extras: a server without them (or a failed summary read) still shows the day.
      const optional = <T,>(p: Promise<T>) => p.catch(e => { if (e instanceof Offline || e instanceof Unauthorized) throw e; return null })
      const [health, log, facts, summary, settings] = await guard(() => Promise.all([
        api.health().catch(() => null), api.logToday(), api.facts(), optional(api.summary()), api.settings(),
      ]))
      setData({ health, log, facts, summary, settings })
      setLoaded(true)
      setError(null)
      setLastGood(new Date().toISOString())
    } catch (e) {
      // Offline and a bad key are already handled by guard; anything else (a 404 from an older server, a 500) is shown.
      if (!(e instanceof Offline) && !(e instanceof Unauthorized)) setError((e as Error).message)
    } finally {
      busy.current = false
    }
  }, [guard])

  useEffect(() => {
    if (!session) return
    setUnauthorized(false)
    void refresh()
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [session, refresh])

  const patch = useCallback((p: Partial<DashboardData>) => setData(d => ({ ...d, ...p })), [])

  return { data, loaded, unauthorized, offline, error, lastGood, refresh, guard, patch }
}
