// Voiceprints from the Python voice-service (sherpa-onnx, CAM++ and TitaNet fused). Never throws to the caller.
import { config } from '../config.js'
import { toWav } from '../wav.js'

export type Voiceprint = {
  whole: number[]
  /** The two halves of the speech, only from 3 s of it: they disagree when the clip holds two voices. */
  first?: number[]
  second?: number[]
  seconds: number // speech left after the service's silence gate
  ms: number
}
export type EmbedResult = { ok: true; print: Voiceprint } | { ok: false; reason: 'off' | 'too_short' | 'paused' | 'failed'; error?: string }

const BYTES_PER_SEC = 32_000 // 16 kHz, 16-bit, mono
const MAX_SEC = 8

export const voiceEnabled = () => Boolean(config.voiceUrl)
const base = () => config.voiceUrl.replace(/\/$/, '')

// ---- circuit breaker: after 3 failures in a row, skip voiceprints for 60 s ----
const TRIP_AFTER = 3
const COOL_DOWN_MS = 60_000
let consecutiveFailures = 0
let openUntil = 0
let lastError: string | null = null
let lastOkAt: string | null = null
let model: { models?: string[]; dim?: number } = {}

function recordFailure(msg: string) {
  lastError = msg
  if (++consecutiveFailures >= TRIP_AFTER && Date.now() >= openUntil) {
    openUntil = Date.now() + COOL_DOWN_MS
    console.warn(`[voice] ${consecutiveFailures} failures in a row; pausing voice recognition for ${COOL_DOWN_MS / 1000}s`)
  }
}
function recordSuccess() {
  if (openUntil) console.log('[voice] voice service recovered')
  consecutiveFailures = 0; openUntil = 0; lastError = null; lastOkAt = new Date().toISOString()
}

/** For /health and the voice dashboard. */
export function voiceStatus() {
  if (!config.voiceUrl) return { state: 'not configured' as const }
  if (Date.now() < openUntil) return { state: 'unreachable' as const, retryInSec: Math.ceil((openUntil - Date.now()) / 1000), lastError, ...model }
  if (!lastOkAt) return { state: 'not reached yet' as const, lastError, ...model }
  return { state: consecutiveFailures ? ('degraded' as const) : ('on' as const), lastOkAt, lastError, ...model }
}

/** Health-check the voice service: at startup and every 30 s, so the dashboard shows an outage without waiting for speech. */
export async function probe(): Promise<boolean> {
  if (!config.voiceUrl) return true
  try {
    const res = await fetch(`${base()}/health`, { signal: AbortSignal.timeout(3000) })
    const json = (await res.json()) as { loaded?: boolean; models?: string[]; dim?: number; error?: string | null }
    model = { models: json.models, dim: json.dim }
    if (!json.loaded) {
      lastError = json.error ?? 'models still loading'
      return false
    }
    if (!lastOkAt || consecutiveFailures) console.log(`[voice] reachable: ${json.models?.join(' + ')} (dim ${json.dim})`)
    recordSuccess()
    return true
  } catch (e) {
    if (consecutiveFailures === 0) console.warn(`[voice] not reachable at ${config.voiceUrl}: ${(e as Error).message}. Answers are unaffected.`)
    recordFailure((e as Error).message)
    return false
  }
}

/** Voiceprint of one clip (raw 16 kHz mono 16-bit PCM). The newest 8 s are used. */
export async function embed(pcm: Uint8Array): Promise<EmbedResult> {
  if (!config.voiceUrl) return { ok: false, reason: 'off' }
  if (Date.now() < openUntil) return { ok: false, reason: 'paused' }
  const clip = pcm.subarray(Math.max(0, pcm.byteLength - MAX_SEC * BYTES_PER_SEC))
  try {
    const res = await fetch(`${base()}/embed`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav', ...(config.voiceSecret ? { 'x-voice-secret': config.voiceSecret } : {}) },
      body: toWav(Buffer.from(clip.buffer, clip.byteOffset, clip.byteLength)),
      signal: AbortSignal.timeout(4000),
    })
    if (res.status === 422) { recordSuccess(); return { ok: false, reason: 'too_short' } }
    if (!res.ok) throw new Error(`voice-service ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const print = (await res.json()) as Voiceprint
    recordSuccess()
    return { ok: true, print }
  } catch (e) {
    const msg = (e as Error).message
    console.warn('[voice] embed failed:', msg)
    recordFailure(msg)
    return { ok: false, reason: 'failed', error: msg }
  }
}
