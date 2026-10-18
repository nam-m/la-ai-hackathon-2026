import type { DaySummary, FactInput, Health, LogToday, QARecord, Settings } from './types'

// Empty in dev (Vite proxies to the server); the server's public URL in production.
const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')
const KEY = 'rewind.key'

export class Unauthorized extends Error {}
export class Offline extends Error {}

const storage = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string | null) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v) } catch { /* private mode */ } },
}
export const prefs = storage

/** The family key is the server's FACTS_SECRET. A /#key=... link signs a browser in once and is then cleared. */
export function takeKeyFromLink() {
  const m = /^#key=(.+)$/.exec(location.hash)
  if (!m) return
  storage.set(KEY, decodeURIComponent(m[1]))
  history.replaceState(null, '', location.pathname)
}
export const getKey = () => storage.get(KEY)
export const setKey = (key: string | null) => storage.set(KEY, key)

async function request<T>(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const { method = 'GET', body, auth = true } = init
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(auth ? { authorization: `Bearer ${getKey() ?? ''}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new Offline()
  }
  if (res.status === 401) throw new Unauthorized()
  // A sleeping or restarting host (Render, Railway) and the dev proxy answer these when the server itself is down.
  if (res.status === 502 || res.status === 503 || res.status === 504) throw new Offline()
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
  return data as T
}

export const api = {
  health: () => request<Health>('/health', { auth: false }),
  logToday: () => request<LogToday>('/log/today'),
  facts: () => request<{ facts: QARecord[] }>('/facts').then(r => r.facts),
  saveFacts: (facts: FactInput[]) => request<{ stored: number }>('/facts', { method: 'POST', body: { v: 1, facts } }),
  deleteFact: (id: string) => request<{ removed: boolean }>(`/facts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  summary: () => request<{ summary: DaySummary | null }>('/summary/today').then(r => r.summary),
  generateSummary: () => request<{ runId: string }>('/creao/summary', { method: 'POST' }),
  settings: () => request<Settings>('/settings'),
  saveSettings: (s: Settings) => request<Settings>('/settings', { method: 'POST', body: s }),
}
