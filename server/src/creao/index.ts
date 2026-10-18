// Contract 5: Creao module. D owns this file and replaces the stubs.
// Nothing here is ever awaited in the live path.
import { config } from '../config.js'
import { isDemo } from '../demo.js'
import * as store from '../store.js'
import type { RunKind } from '../types.js'
import { parseAgentJson, startRun, waitForRun, type AgentName } from './capi.js'
import { buildDataJson, datesEnding } from './input.js'

export async function submitClip(wav: Buffer, range: { fromIso: string; toIso: string }): Promise<string> {
  console.log(`[creao stub] submitClip ${wav.length} bytes ${range.fromIso} to ${range.toIso}`)
  return `run_stub_${Date.now()}`
}

/**
 * Every 5 minutes: new transcript lines, Q&A pairs, question events and tone records.
 * The log, summary and patterns agents use transcript + tone together (spec v4 section 8).
 */
export async function submitLog(batch: {
  fromIso: string
  toIso: string
  transcript: unknown[]
  pairs: unknown[]
  events: unknown[]
  tones: unknown[]
}): Promise<string> {
  console.log(`[creao stub] submitLog ${batch.transcript.length} lines, ${batch.pairs.length} pairs, ${batch.events.length} questions, ${batch.tones.length} tones`)
  return `run_stub_${Date.now()}`
}

/**
 * The given local dates' data as the agents' `data_json`. With DEMO_DATA=1 the demo day is included, so a summary
 * asked for in the demo describes what the dashboard shows; otherwise only real data (a demo day is cleared then anyway).
 */
function dataJsonFor(dates: string[]) {
  const real = <T extends { id: string }>(xs: T[]) => (config.demoData ? xs : xs.filter(x => !isDemo(x.id)))
  const { events, tones } = store.between('', '~')
  return buildDataJson(dates, real(events), real(tones), real(store.allRecords()), store.localDate)
}

// Agents with a run in flight. A second start is refused, so a double click can't spend credits twice.
const inFlight = new Set<AgentName>()

/**
 * Starts a run and returns its id at once. The result is polled in the background and handed to `save` (or
 * `fail`); a failure is logged, never thrown into a live path. Each run spends credits, so nothing retries.
 * `kind` files the id in the run registry for the agents the registry knows (summary, patterns).
 */
async function launch(
  agent: AgentName,
  kind: RunKind | null,
  inputs: Record<string, unknown>,
  save: (out: Record<string, unknown>, runId: string) => void,
  fail: (message: string, runId: string) => void = () => {},
) {
  if (inFlight.has(agent)) throw new Error(`${agent} is already running; wait for it to finish`)
  inFlight.add(agent)
  let runId: string
  try {
    runId = await startRun(agent, inputs)
  } catch (e) {
    inFlight.delete(agent)
    throw e
  }
  if (kind) store.runRegistry.put(runId, kind)
  waitForRun(agent, runId)
    .then(run => {
      const out = parseAgentJson(run)
      if (!out || !('schema_version' in out)) {
        const why = `finished without the agent's JSON: ${(run.result?.chatText ?? '').slice(0, 200)}`
        console.warn(`[creao] ${agent} run ${runId} ${why}`)
        fail(why, runId)
        return
      }
      save(out, runId)
      console.log(`[creao] ${agent} run ${runId} saved`)
    })
    .catch(e => {
      console.warn(`[creao] ${agent} run ${runId} failed:`, (e as Error).message)
      fail((e as Error).message, runId)
    })
    .finally(() => {
      inFlight.delete(agent)
      if (kind) store.runRegistry.take(runId)
    })
  return runId
}

/** Daily brief for one local date; the saved summary appears at GET /summary/today when the run finishes. */
export async function runSummary(dateIso: string): Promise<string> {
  return launch('dailyBrief', 'summary', { date: dateIso, data_json: dataJsonFor([dateIso]) }, out =>
    store.saveSummary(dateIso, { ...out, date: dateIso, generatedAt: new Date().toISOString() }))
}

/** Pattern finder over the 7 local dates ending at `dateIso`. */
export async function runPatterns(dateIso: string): Promise<string> {
  const dates = datesEnding(dateIso, 7)
  return launch('patternFinder', 'patterns', { end_date: dateIso, data_json: dataJsonFor(dates) }, out =>
    store.savePatterns({ ...out, toIso: dateIso, generatedAt: new Date().toISOString() }))
}

/** Open Questions over the 7 local dates ending at `dateIso`: what the glasses could not answer, filed under that date. */
export async function runOpenQuestions(dateIso: string): Promise<string> {
  return launch('openQuestions', null, { end_date: dateIso, data_json: dataJsonFor(datesEnding(dateIso, 7)) }, out =>
    store.saveOpenQuestions(dateIso, { ...out, generatedAt: new Date().toISOString() }))
}

export type CareRole = 'caregiver' | 'clinician'
export type CareResult = { status: 'running' | 'done' | 'failed'; result?: Record<string, unknown>; error?: string }
const careRuns = new Map<string, CareResult>()

/**
 * Care assistant: turns a caregiver's or clinician's request into a proposal. It only proposes. Nothing is saved to
 * the store here; a person approves in the family app, which posts the fact through POST /facts. Poll `careResult`.
 */
export async function runCare(role: CareRole, request: string, dateIso: string): Promise<string> {
  const inputs = { role, request, today: dateIso, data_json: dataJsonFor(datesEnding(dateIso, 7)) }
  const runId = await launch('careAssistant', null, inputs,
    (out, id) => careRuns.set(id, { status: 'done', result: out }),
    (message, id) => careRuns.set(id, { status: 'failed', error: message }))
  if (!careRuns.has(runId)) careRuns.set(runId, { status: 'running' }) // the run may already have finished
  if (careRuns.size > 50) careRuns.delete(careRuns.keys().next().value!)
  return runId
}

export const careResult = (runId: string): CareResult | undefined => careRuns.get(runId)

export async function handleWebhook(body: unknown): Promise<void> {
  console.log('[creao stub] webhook', JSON.stringify(body).slice(0, 200))
}
