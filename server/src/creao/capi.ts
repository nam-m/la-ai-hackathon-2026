// Client for CREAO's app trigger API (agent.creao.ai/api/v1), one saved agent per capi_ key.
// Verified 2026-10-18: POST /apps/{appId}/runs {inputs} -> {id, status:"pending", appId, appName};
// GET /apps/{appId}/runs/{id} -> {id, status, threadId, result:{text, chatText}, errorCode, startedAt, completedAt}.
// A trivial run took about 40 s, so never wait on one in a live path. Keys come from the environment only.

export type AgentName = 'dailyBrief' | 'patternFinder' | 'openQuestions' | 'careAssistant'

export const APP_IDS: Record<AgentName, string> = {
  dailyBrief: 'cc26aad8-308e-4bba-9d1a-164dfed81be5',
  patternFinder: '1dd9ddd9-a2a2-491a-a4aa-89f165fd277f',
  openQuestions: '44b1a649-026f-4b4f-84f5-1142ba9a2c63',
  careAssistant: 'ff8a0dd2-4b8a-454f-a3c5-e231d5c5edd2',
}

export const KEY_ENV: Record<AgentName, string> = {
  dailyBrief: 'CAPI_KEY_DAILY_BRIEF',
  patternFinder: 'CAPI_KEY_PATTERN_FINDER',
  openQuestions: 'CAPI_KEY_OPEN_QUESTIONS',
  careAssistant: 'CAPI_KEY_CARE_ASSISTANT',
}

export type RunInfo = {
  id: string
  status: string
  result?: { text?: string; chatText?: string } | null
  errorCode?: string | null
}

const base = () => (process.env.CREAO_APP_API_BASE || 'https://agent.creao.ai/api/v1').replace(/\/$/, '')

function keyFor(agent: AgentName) {
  const key = process.env[KEY_ENV[agent]]
  if (!key) throw new Error(`${KEY_ENV[agent]} is not set`)
  return key
}

async function call(agent: AgentName, path: string, init: { method: string; body?: unknown }): Promise<RunInfo> {
  const res = await fetch(`${base()}/apps/${APP_IDS[agent]}${path}`, {
    method: init.method,
    headers: { Authorization: `Bearer ${keyFor(agent)}`, 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await res.text()
  // Never echo the response into an error if it could carry a key; the status is enough to debug.
  if (!res.ok) throw new Error(`CREAO ${agent} ${init.method} ${path || '/'} failed: HTTP ${res.status}`)
  try { return JSON.parse(text) as RunInfo } catch { throw new Error(`CREAO ${agent}: response was not JSON`) }
}

/** Starts a run and returns its id at once. Every run spends credits, so callers must not retry in a loop. */
export async function startRun(agent: AgentName, inputs: Record<string, unknown>): Promise<string> {
  const run = await call(agent, '/runs', { method: 'POST', body: { inputs } })
  if (!run.id) throw new Error(`CREAO ${agent}: no run id in the response`)
  return run.id
}

export const getRun = (agent: AgentName, runId: string) => call(agent, `/runs/${encodeURIComponent(runId)}`, { method: 'GET' })

const FAILED = new Set(['failed', 'error', 'cancelled', 'canceled', 'timeout', 'timed_out'])

/** Polls until the run completes. Throws on a failed status, an error code, or the time limit. */
export async function waitForRun(agent: AgentName, runId: string, opts: { intervalMs?: number; timeoutMs?: number } = {}): Promise<RunInfo> {
  const intervalMs = opts.intervalMs ?? Number(process.env.CREAO_POLL_MS || 3000)
  const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000)
  for (;;) {
    const run = await getRun(agent, runId)
    if (run.errorCode || FAILED.has(run.status)) throw new Error(`CREAO ${agent} run ${runId} ${run.status}${run.errorCode ? ` (${run.errorCode})` : ''}`)
    if (run.status === 'completed') return run
    if (Date.now() + intervalMs > deadline) throw new Error(`CREAO ${agent} run ${runId} still ${run.status} after the time limit`)
    await new Promise(r => setTimeout(r, intervalMs))
  }
}

/**
 * The agent's JSON object out of a finished run. result.text is a JSON string, sometimes wrapped as {"response": "..."}
 * (an agent that needs input answers that way), and the object may sit inside prose. Some agents put only their
 * script's stats in text and the real object (with schema_version) in a ```json block in chatText, so both are read
 * and the first object with schema_version wins. Returns null when there is no object at all.
 */
export function parseAgentJson(run: RunInfo): Record<string, unknown> | null {
  const tryParse = (s: string): unknown => { try { return JSON.parse(s) } catch { return undefined } }
  const asObject = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
  const objectIn = (s: string): Record<string, unknown> | null => {
    const direct = asObject(tryParse(s))
    if (direct) return direct
    const blocks = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(m => asObject(tryParse(m[1])))
    const fenced = blocks.find(b => b && 'schema_version' in b) ?? blocks.find(Boolean)
    if (fenced) return fenced
    const a = s.indexOf('{'), b = s.lastIndexOf('}')
    return a >= 0 && b > a ? asObject(tryParse(s.slice(a, b + 1))) : null
  }
  const unwrap = (o: Record<string, unknown> | null) =>
    o && typeof o.response === 'string' && !('schema_version' in o) ? objectIn(o.response) : o
  const found = [run.result?.text, run.result?.chatText].map(t => (t ? unwrap(objectIn(t)) : null))
  return found.find(o => o && 'schema_version' in o) ?? found.find(Boolean) ?? null
}
