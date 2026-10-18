import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const directory = await mkdtemp(join(tmpdir(), 'creao-tests-'))
process.env.DOTENV_CONFIG_PATH = join(directory, 'no-env-file')
process.env.DATA_FILE = join(directory, 'store.json')
process.env.TIMEZONE = 'America/Los_Angeles'
process.env.CREAO_POLL_MS = '1'
process.env.CAPI_KEY_DAILY_BRIEF = 'capi_test_daily'
process.env.CAPI_KEY_PATTERN_FINDER = 'capi_test_pattern'
process.env.CAPI_KEY_OPEN_QUESTIONS = 'capi_test_oq'
process.env.CAPI_KEY_CARE_ASSISTANT = 'capi_test_care'
const store = await import('../src/store.js')
const { parseAgentJson, startRun, waitForRun, APP_IDS } = await import('../src/creao/capi.js')
const { toAgentEvents, buildDataJson, datesEnding } = await import('../src/creao/input.js')
const creao = await import('../src/creao/index.js')
after(async () => { store.flush(); await rm(directory, { recursive: true, force: true }) })

const realFetch = globalThis.fetch
const mock = (handler: (url: string, init: RequestInit) => unknown | Promise<unknown>) => {
  const calls: { url: string; init: RequestInit }[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    const out = await handler(String(url), init)
    return new Response(typeof out === 'string' ? out : JSON.stringify(out), { status: 200 })
  }) as typeof fetch
  return calls
}
after(() => { globalThis.fetch = realFetch })

test('parseAgentJson reads the agent object, a wrapped response, and rejects prose', () => {
  assert.deepEqual(parseAgentJson({ id: '1', status: 'completed', result: { text: '{"schema_version":"1.0","a":1}' } }), { schema_version: '1.0', a: 1 })
  assert.deepEqual(parseAgentJson({ id: '1', status: 'completed', result: { text: 'Here: {"schema_version":"1.0","a":1} done' } }), { schema_version: '1.0', a: 1 })
  assert.deepEqual(parseAgentJson({ id: '1', status: 'completed', result: { text: JSON.stringify({ response: '{"schema_version":"1.0","b":2}' }) } }), { schema_version: '1.0', b: 2 })
  const ask = parseAgentJson({ id: '1', status: 'completed', result: { text: JSON.stringify({ response: 'end_date is needed' }) } })
  assert.equal(ask?.schema_version, undefined)
  assert.equal(parseAgentJson({ id: '1', status: 'completed', result: { text: 'no json here' } }), null)
})

test('parseAgentJson falls back to the json block in chatText when text holds only script stats', () => {
  // Shape of a real Daily brief run (2026-10-18): stats in text, the brief in chatText.
  const run = {
    id: '1', status: 'completed', result: {
      text: '{"date":"2026-10-18","wearer_questions":0,"events_seen":0,"repeat_groups":0}',
      chatText: 'Inputs validated. Running the bundled script now.Here is the Daily brief:\n\n```json\n{\n  "schema_version": "1.0",\n  "date": "2026-10-18",\n  "summary": "Not enough data today.",\n  "repeatedQuestions": []\n}\n```\n\nLet me know if {anything} else.',
    },
  }
  assert.deepEqual(parseAgentJson(run), { schema_version: '1.0', date: '2026-10-18', summary: 'Not enough data today.', repeatedQuestions: [] })
})

test('startRun posts inputs to the app with the Bearer key and returns the run id', async () => {
  const calls = mock(() => ({ id: 'run-1', status: 'pending' }))
  assert.equal(await startRun('dailyBrief', { date: '2026-10-18' }), 'run-1')
  assert.equal(calls[0].url, `https://agent.creao.ai/api/v1/apps/${APP_IDS.dailyBrief}/runs`)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer capi_test_daily')
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { inputs: { date: '2026-10-18' } })
})

test('a missing key is a clear error and never reaches the network', async () => {
  const calls = mock(() => ({}))
  const key = process.env.CAPI_KEY_OPEN_QUESTIONS
  delete process.env.CAPI_KEY_OPEN_QUESTIONS
  try { await assert.rejects(startRun('openQuestions', {}), /CAPI_KEY_OPEN_QUESTIONS is not set/) } finally { process.env.CAPI_KEY_OPEN_QUESTIONS = key }
  assert.equal(calls.length, 0)
})

test('an HTTP error does not echo the response body', async () => {
  globalThis.fetch = (async () => new Response('secret-detail capi_x', { status: 401 })) as typeof fetch
  await assert.rejects(startRun('dailyBrief', {}), (e: Error) => /HTTP 401/.test(e.message) && !/secret-detail/.test(e.message))
})

test('waitForRun polls until completed, and fails on errorCode or failed status', async () => {
  let n = 0
  mock(() => (++n < 3 ? { id: 'r', status: 'pending' } : { id: 'r', status: 'completed', result: { text: '{}' } }))
  assert.equal((await waitForRun('dailyBrief', 'r')).status, 'completed')
  assert.equal(n, 3)
  mock(() => ({ id: 'r', status: 'completed', errorCode: 'BOOM' }))
  await assert.rejects(waitForRun('dailyBrief', 'r'), /BOOM/)
  mock(() => ({ id: 'r', status: 'failed' }))
  await assert.rejects(waitForRun('dailyBrief', 'r'), /failed/)
  mock(() => ({ id: 'r', status: 'running' }))
  await assert.rejects(waitForRun('dailyBrief', 'r', { intervalMs: 1, timeoutMs: 5 }), /time limit/)
})

test('events map to the seed shape; no tone record leaves the tone key out', () => {
  const events = [
    { id: 'e1', at: '2026-10-18T16:00:00.000Z', question: 'When is Sarah coming?', matchedRecordId: 'f1', matchScore: 0.9, toneId: 't1' },
    { id: 'e2', at: '2026-10-18T17:00:00.000Z', question: 'What is for dinner?', matchedRecordId: null, matchScore: null },
  ]
  const tones = [{ id: 't1', questionEventId: 'e1', at: events[0].at, provider: 'x', scores: {}, top: ['fearful'], worry: 0.7, quality: 'ok' as const }]
  const out = toAgentEvents(events, tones)
  assert.deepEqual(out[0], { id: 'e1', at: events[0].at, role: 'wearer', text: 'When is Sarah coming?', matched_fact_id: 'f1', score: 0.9, decision: 'answered', tone: { top: 'fearful', worry: true, quality: 'ok' } })
  assert.equal(out[1].decision, 'abstained')
  assert.equal('tone' in out[1], false)
})

test('data_json groups events by local date and carries family facts only', () => {
  const events = [
    { id: 'e1', at: '2026-10-18T16:00:00.000Z', question: 'q', matchedRecordId: null, matchScore: null },
    { id: 'e2', at: '2026-10-17T16:00:00.000Z', question: 'q', matchedRecordId: null, matchScore: null },
  ]
  const records = [
    { id: 'f1', question: 'When is Sarah coming?', answer: 'Thursday', askedAt: '', answeredAt: '', answeredBy: 'Sarah', source: 'family' as const, standing: true },
    { id: 's1', question: 'x', answer: 'y', askedAt: '', answeredAt: '', answeredBy: null, source: 'spoken' as const, standing: false },
  ]
  const parsed = JSON.parse(buildDataJson(['2026-10-17', '2026-10-18'], events, [], records, store.localDate))
  assert.deepEqual(parsed.days.map((d: { date: string; events: unknown[] }) => [d.date, d.events.length]), [['2026-10-17', 1], ['2026-10-18', 1]])
  assert.deepEqual(parsed.facts, [{ id: 'f1', question: 'When is Sarah coming?', answer: 'Thursday' }])
  assert.deepEqual(datesEnding('2026-10-18', 3), ['2026-10-16', '2026-10-17', '2026-10-18'])
})

test('runSummary starts the Daily brief, then saves the agent JSON under that date', async () => {
  store.addEvent({ id: 'real1', at: new Date().toISOString(), question: 'When is Sarah coming?', matchedRecordId: null, matchScore: null })
  const date = store.localDate(new Date().toISOString())
  let polls = 0
  const calls = mock((url, init) => {
    if (init.method === 'POST') return { id: 'run-sum', status: 'pending' }
    return ++polls < 2 ? { id: 'run-sum', status: 'running' } : { id: 'run-sum', status: 'completed', result: { text: '{"schema_version":"1.0","summary":"A calm day."}' } }
  })
  const id = await creao.runSummary(date)
  assert.equal(id, 'run-sum')
  const body = JSON.parse(String(calls[0].init.body))
  assert.equal(body.inputs.date, date)
  assert.equal(JSON.parse(body.inputs.data_json).days[0].events[0].id, 'real1')
  for (let i = 0; i < 50 && !store.getDay(date)?.summary; i++) await new Promise(r => setTimeout(r, 10))
  assert.equal(store.getDay(date)?.summary?.summary, 'A calm day.')
  assert.ok(typeof store.getDay(date)?.summary?.generatedAt === 'string') // the family app shows "Last written at"
  assert.equal(store.runRegistry.has('run-sum'), false)
})

test('a run that answers without the agent JSON saves nothing', async () => {
  const date = '2026-10-10'
  mock((_u, init) => (init.method === 'POST' ? { id: 'run-bad', status: 'pending' } : { id: 'run-bad', status: 'completed', result: { text: JSON.stringify({ response: 'I need end_date' }) } }))
  await creao.runPatterns(date)
  await new Promise(r => setTimeout(r, 80))
  assert.equal(store.getDay(date)?.patterns, undefined)
})

const finishing = (id: string, text: string) => (_u: string, init: RequestInit) =>
  init.method === 'POST' ? { id, status: 'pending' } : { id, status: 'completed', result: { text } }
const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise(r => setTimeout(r, 10)) }

test('runOpenQuestions sends 7 days of data and files the result under the date', async () => {
  const date = store.localDate(new Date().toISOString())
  const calls = mock(finishing('run-oq', '{"schema_version":"1.0","open_questions":[{"cluster_id":"oq-dinner"}]}'))
  assert.equal(await creao.runOpenQuestions(date), 'run-oq')
  const inputs = JSON.parse(String(calls[0].init.body)).inputs
  assert.equal(inputs.end_date, date)
  assert.equal(JSON.parse(inputs.data_json).days.length, 7)
  await until(() => !!store.getDay(date)?.openQuestions)
  assert.deepEqual((store.getDay(date)?.openQuestions as { open_questions: { cluster_id: string }[] }).open_questions[0].cluster_id, 'oq-dinner')
})

test('runCare returns a proposal through careResult and saves nothing', async () => {
  const date = store.localDate(new Date().toISOString())
  const factsBefore = store.allRecords().length
  const calls = mock(finishing('run-care', '{"schema_version":"1.0","role":"caregiver","proposal":{"action":"replace_fact"}}'))
  assert.equal(await creao.runCare('caregiver', 'I am visiting Thursday at 3', date), 'run-care')
  const inputs = JSON.parse(String(calls[0].init.body)).inputs
  assert.deepEqual([inputs.role, inputs.request, inputs.today], ['caregiver', 'I am visiting Thursday at 3', date])
  await until(() => creao.careResult('run-care')?.status === 'done')
  assert.equal((creao.careResult('run-care')?.result as { role: string }).role, 'caregiver')
  assert.equal(store.allRecords().length, factsBefore)
  assert.equal(creao.careResult('nope'), undefined)
})

test('a failed care run reports failed with the reason', async () => {
  mock((_u, init) => (init.method === 'POST' ? { id: 'run-care2', status: 'pending' } : { id: 'run-care2', status: 'failed' }))
  await creao.runCare('clinician', 'only ask after 5 asks', '2026-10-18')
  await until(() => creao.careResult('run-care2')?.status === 'failed')
  assert.match(creao.careResult('run-care2')?.error ?? '', /failed/)
})

test('a second start while one is running is refused and sends nothing', async () => {
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const calls = mock(async (_u, init) => {
    if (init.method === 'POST') return { id: 'run-slow', status: 'pending' }
    await gate
    return { id: 'run-slow', status: 'completed', result: { text: '{"schema_version":"1.0"}' } }
  })
  await creao.runOpenQuestions('2026-10-18')
  const before = calls.length
  await assert.rejects(creao.runOpenQuestions('2026-10-18'), /already running/)
  assert.equal(calls.filter(c => c.init.method === 'POST').length, 1)
  assert.ok(calls.length >= before)
  release()
  await until(() => calls.some(c => c.init.method === 'GET'))
  await new Promise(r => setTimeout(r, 50))
  await assert.doesNotReject(creao.runOpenQuestions('2026-10-18')) // free again once the first finished
})
