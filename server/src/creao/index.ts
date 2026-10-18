// Contract 5: Creao module. D owns this file and replaces the stubs.
// Nothing here is ever awaited in the live path.
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

/** Real (non-demo) data for the given local dates, as the agents' `data_json`. */
function dataJsonFor(dates: string[]) {
  const real = <T extends { id: string }>(xs: T[]) => xs.filter(x => !isDemo(x.id))
  const { events, tones } = store.between('', '~')
  return buildDataJson(dates, real(events), real(tones), real(store.allRecords()), store.localDate)
}

/**
 * Starts a run, files its id under `kind`, and returns the id at once. The result is polled in the background and
 * handed to `save`; a failure is logged, never thrown into a live path. Each run spends credits, so nothing retries.
 */
async function launch(agent: AgentName, kind: RunKind, inputs: Record<string, unknown>, save: (out: Record<string, unknown>) => void) {
  const runId = await startRun(agent, inputs)
  store.runRegistry.put(runId, kind)
  waitForRun(agent, runId)
    .then(run => {
      const out = parseAgentJson(run)
      if (!out || !('schema_version' in out)) {
        console.warn(`[creao] ${kind} run ${runId} finished without the agent's JSON: ${(run.result?.chatText ?? '').slice(0, 200)}`)
        return
      }
      save(out)
      console.log(`[creao] ${kind} run ${runId} saved`)
    })
    .catch(e => console.warn(`[creao] ${kind} run ${runId} failed:`, (e as Error).message))
    .finally(() => store.runRegistry.take(runId))
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
    store.savePatterns({ ...out, toIso: dateIso }))
}

export async function handleWebhook(body: unknown): Promise<void> {
  console.log('[creao stub] webhook', JSON.stringify(body).slice(0, 200))
}
