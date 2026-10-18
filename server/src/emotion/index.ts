// Tone module: estimated tone of voice for wearer questions, via the Python tone-service (emotion2vec+).
// Runs beside matching, never in front of it. Never throws to the caller. Family dashboard only.
import { config } from '../config.js'
import * as store from '../store.js'
import { toWav } from '../wav.js'
import type { ToneRecord } from '../types.js'

const BYTES_PER_SEC = 32_000 // 16 kHz, 16-bit, mono
const MIN_SEC = 1.0
const MAX_SEC = 8.0
const MIN_RMS_DB = -45 // quieter than this is treated as silence

export function rmsDb(pcm: Uint8Array) {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength - (pcm.byteLength % 2))
  const n = view.byteLength / 2
  if (!n) return -Infinity
  let sum = 0
  for (let i = 0; i < n; i++) { const s = view.getInt16(i * 2, true) / 32768; sum += s * s }
  return 10 * Math.log10(sum / n || 1e-12)
}

export const toneEnabled = () => Boolean(config.toneUrl) && store.getSettings().toneAnalysis

// ---- circuit breaker: after 3 failures in a row, skip tone for 60 s instead of trying on every question ----
const TRIP_AFTER = 3
const COOL_DOWN_MS = 60_000
let consecutiveFailures = 0
let openUntil = 0
let lastError: string | null = null
let lastOkAt: string | null = null
let reached = false // set once the service has answered (probe or a real call); /health stays honest until then

function recordFailure(msg: string) {
  lastError = msg
  if (++consecutiveFailures >= TRIP_AFTER && Date.now() >= openUntil) {
    openUntil = Date.now() + COOL_DOWN_MS
    console.warn(`[tone] ${consecutiveFailures} failures in a row; pausing tone for ${COOL_DOWN_MS / 1000}s`)
  }
}
function recordSuccess() {
  if (openUntil) console.log('[tone] tone service recovered')
  consecutiveFailures = 0; openUntil = 0; lastError = null; lastOkAt = new Date().toISOString(); reached = true
}

/** For /health: is tone working right now? */
export function toneStatus() {
  if (!config.toneUrl) return { state: 'not configured' as const }
  if (!store.getSettings().toneAnalysis) return { state: 'off' as const }
  if (Date.now() < openUntil) return { state: 'unreachable' as const, retryInSec: Math.ceil((openUntil - Date.now()) / 1000), lastError }
  if (!reached) return { state: 'not reached yet' as const, lastError }
  return { state: consecutiveFailures ? ('degraded' as const) : ('on' as const), lastOkAt, lastError }
}

/**
 * Ping the tone service so problems show up before the demo, not during it. Called at startup and every
 * 30 s until the model is loaded (the first start downloads it); /health reports "on" only after that.
 */
export async function probe(): Promise<boolean> {
  if (!config.toneUrl) return true
  try {
    const res = await fetch(`${config.toneUrl.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(3000) })
    const json = (await res.json()) as { model?: string; mock?: boolean; loaded?: boolean }
    if (json.mock) console.warn('[tone] WARNING: tone service is in MOCK mode. Scores are fake; never demo this.')
    console.log(`[tone] reachable: model=${json.model} loaded=${json.loaded}`)
    if (!json.loaded) { lastError = 'model still loading'; return false }
    recordSuccess()
    return true
  } catch (e) {
    lastError = (e as Error).message
    console.warn(`[tone] not reachable at ${config.toneUrl}: ${lastError}. Answers are unaffected.`)
    return false
  }
}

/** Analyze one wearer question's audio. Returns the stored record, or null when skipped/failed. */
export async function analyzeQuestion(questionEventId: string, pcm: Uint8Array | null): Promise<ToneRecord | null> {
  if (!toneEnabled() || !pcm) return null
  if (Date.now() < openUntil) return null // breaker open: skip quietly
  const base = { id: store.newId('tone'), questionEventId, at: new Date().toISOString(), provider: 'emotion2vec+', scores: {}, top: [], worry: 0 }
  try {
    const seconds = pcm.byteLength / BYTES_PER_SEC
    if (seconds < MIN_SEC) return save({ ...base, quality: 'too_short' })
    if (rmsDb(pcm) < MIN_RMS_DB) return save({ ...base, quality: 'too_quiet' })
    const clip = pcm.subarray(0, Math.floor(MAX_SEC * BYTES_PER_SEC))

    const res = await fetch(`${config.toneUrl.replace(/\/$/, '')}/tone`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav', 'x-tone-secret': config.toneSecret },
      body: toWav(Buffer.from(clip.buffer, clip.byteOffset, clip.byteLength)),
      signal: AbortSignal.timeout(8000),
    })
    if (res.status === 422) { recordSuccess(); return save({ ...base, quality: 'too_short' }) }
    if (!res.ok) throw new Error(`tone-service ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const json = (await res.json()) as { model: string; scores: Record<string, number>; top: string[] }
    recordSuccess()
    const worry = Math.min(1, (json.scores.fearful ?? 0) + (json.scores.sad ?? 0))
    return save({ ...base, provider: json.model, scores: json.scores, top: json.top, worry: +worry.toFixed(3), quality: 'ok' })
  } catch (e) {
    const msg = (e as Error).message
    console.warn('[tone] failed:', msg)
    recordFailure(msg)
    return save({ ...base, quality: 'failed' })
  }
}

function save(t: ToneRecord) {
  store.addTone(t)
  console.log(`[tone] ${t.questionEventId} ${t.quality}${t.quality === 'ok' ? ` worry=${t.worry} top=${t.top.join(',')}` : ''}`)
  return t.quality === 'ok' ? t : null
}
