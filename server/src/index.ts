import http from 'node:http'
import express, { type NextFunction, type Request, type Response } from 'express'
import { WebSocketServer } from 'ws'
import { config, matcherName, verifierName } from './config.js'
import * as store from './store.js'
import * as matcher from './matcher.js'
import * as creao from './creao/index.js'
import * as emotion from './emotion/index.js'
import * as voices from './voices/client.js'
import { voiceRoutes } from './voices/routes.js'
import * as demo from './demo.js'
import { factProblem, saveFacts } from './facts.js'
import { Session, sessions, answerMessage, formatTime } from './session.js'
import type { FactInput, QuestionEvent, RunKind } from './types.js'

store.loadStore()
// DEMO_DATA off: sweep any demo day left on the volume from an earlier demo run.
if (config.demoData) demo.seedDemo()
else demo.clearDemo()

const app = express()
app.use(express.json({ limit: '1mb' }))

// CORS: the Even Hub app runs in a WebView, so its fetches need this.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  if (req.method === 'OPTIONS') return void res.sendStatus(204)
  next()
})

const requireSecret = (req: Request, res: Response, next: NextFunction) => {
  if (req.headers.authorization !== `Bearer ${config.factsSecret}`) return void res.status(401).json({ error: 'unauthorized' })
  next()
}

// Creao can't send our Bearer header, so WEBHOOK_SECRET rides in webhook_url (webhookUrl() in config.ts).
const requireWebhookSecret = (req: Request, res: Response, next: NextFunction) => {
  if (req.query.s !== config.webhookSecret) return void res.status(401).json({ error: 'unauthorized' })
  next()
}

const today = () => store.localDate(new Date().toISOString())

app.get('/health', (_req, res) => {
  res.json({
    ok: true, sessions: sessions.size, paused: [...sessions].filter(s => s.isPaused).length, records: store.allRecords().length,
    matcher: matcherName, verify: verifierName, speech: config.speechProvider,
    tone: emotion.toneStatus(), voice: voices.voiceStatus(),
  })
})

// Voice recognition dashboard for the PC: open /voices#key=<FACTS_SECRET>.
app.use(voiceRoutes(requireSecret))

// Contract 4: POST /facts — adds or replaces facts by id, stored word for word.
app.post('/facts', requireSecret, (req, res) => {
  const body = req.body as { v?: number; facts?: FactInput[] }
  if (!Array.isArray(body?.facts)) return void res.status(400).json({ error: 'facts must be an array' })
  for (const f of body.facts) {
    const problem = factProblem(f)
    if (problem) return void res.status(400).json({ error: `bad fact ${f?.id ?? '(no id)'}: ${problem}` })
  }
  saveFacts(body.facts)
  res.json({ stored: body.facts.length })
})

// Dashboard: family facts the glasses can still use. store.get() hides expired ones the 10-minute prune hasn't removed yet.
app.get('/facts', requireSecret, (_req, res) => {
  res.json({ v: 1, facts: store.allRecords().filter(r => r.source === 'family' && store.get(r.id)) })
})

app.delete('/facts/:id', requireSecret, (req, res) => {
  res.json({ removed: store.remove(req.params.id) })
})

/**
 * Groups asks of the same question. An ask links to the record the glasses showed (matchedRecordId), to the
 * record its spoken answer became (answerRecordId) and, when nothing was shown because two answers disagreed, to
 * both of those (contradiction); asks sharing any record are one question, even after it is answered aloud again
 * and later asks match the newer answer. Unlinked asks group by their own text.
 */
function groupAsks(events: QuestionEvent[]) {
  const parent = new Map<string, string>()
  const find = (k: string): string => { const p = parent.get(k) ?? k; if (p === k) return k; const r = find(p); parent.set(k, r); return r }
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb) }
  const keyOf = (e: QuestionEvent) => `e:${e.id}`
  for (const e of events) {
    if (e.matchedRecordId) union(keyOf(e), `r:${e.matchedRecordId}`)
    if (e.answerRecordId) union(keyOf(e), `r:${e.answerRecordId}`)
    if (e.contradiction) {
      union(keyOf(e), `r:${e.contradiction.spokenRecordId}`)
      union(keyOf(e), `r:${e.contradiction.factRecordId}`)
    }
    if (!e.matchedRecordId && !e.answerRecordId && !e.contradiction) union(keyOf(e), `t:${e.question.toLowerCase().replace(/[^a-z ]/g, '').trim()}`)
  }
  const groups = new Map<string, QuestionEvent[]>()
  for (const e of events) {
    const root = find(keyOf(e))
    groups.set(root, [...(groups.get(root) ?? []), e])
  }
  return [...groups.values()]
}

// Dashboard feed: transcript, every question asked (with repeat counts) and estimated tone.
app.get('/log/today', requireSecret, (_req, res) => {
  const events = store.todaysEvents()
  const tones = new Map(store.todaysTones().map(t => [t.id, t]))
  const worryOf = (e: QuestionEvent) => { const t = e.toneId ? tones.get(e.toneId) : undefined; return t?.quality === 'ok' ? t.worry : null }
  const byId = new Map(store.allRecords().map(r => [r.id, r]))
  // Per ask: was something shown, and whose answer (the shown record, else the spoken answer this ask got,
  // else, when nothing was shown because answers disagreed, the spoken answer in the disagreement).
  const askOf = (e: QuestionEvent) => {
    const record = (id?: string | null) => (id ? byId.get(id) : undefined)
    const answer = record(e.matchedRecordId) ?? record(e.answerRecordId) ?? record(e.contradiction?.spokenRecordId)
    return {
      at: e.at, worry: worryOf(e), shown: Boolean(e.matchedRecordId), contradiction: Boolean(e.contradiction),
      answeredBy: answer?.answeredBy ?? null, source: answer?.source ?? null,
    }
  }
  const repeated = groupAsks(events)
    .filter(g => g.length > 1)
    .map(g => ({ question: g[0].question, count: g.length, times: g.map(e => e.at), worry: g.map(worryOf), asks: g.map(askOf) }))
    .sort((a, b) => b.count - a.count)
  res.json({
    v: 1,
    transcript: store.todaysTranscript(),
    questions: events.map(e => ({ ...e, tone: e.toneId ? tones.get(e.toneId) ?? null : null })),
    repeated,
    pairs: store.todaysSpokenPairs(),
    // Spoken answers that disagree with a family fact: nothing was shown, so the family should fix the fact.
    contradictions: events.filter(e => e.contradiction).map(e => ({
      questionEventId: e.id, at: e.at, question: e.question,
      spoken: byId.get(e.contradiction!.spokenRecordId) ?? null, fact: byId.get(e.contradiction!.factRecordId) ?? null,
    })),
    reminders: store.todaysReminders().map(r => ({ id: r.id, text: r.answer, remindAt: r.remindAt, status: r.reminderStatus ?? 'scheduled', doneAt: r.reminderDoneAt ?? null })),
  })
})

app.get('/settings', requireSecret, (_req, res) => res.json(store.getSettings()))
app.post('/settings', requireSecret, (req, res) => {
  if (typeof req.body?.toneAnalysis !== 'boolean') return void res.status(400).json({ error: 'toneAnalysis must be true or false' })
  store.setSettings({ toneAnalysis: req.body.toneAnalysis })
  console.log(`[settings] toneAnalysis=${req.body.toneAnalysis}`)
  res.json(store.getSettings())
})

app.get('/qa/today', requireSecret, (_req, res) => {
  res.json({ v: 1, pairs: store.todaysSpokenPairs() })
})

// Contract 4: Creao run results. Reply at once, process afterwards.
// D's handleWebhook must also reject run IDs our server didn't start (store.runRegistry).
// If D's router lands, replace the handler below with this one line; /facts stays above, at its contracted URL:
//   app.use('/creao', createCreaoRouter({ factsSecret: config.factsSecret, store: creaoStore }))   // creaoStore from ./facts.js
app.use('/creao/webhook', requireWebhookSecret)
app.post('/creao/webhook', (req, res) => {
  res.sendStatus(200)
  creao.handleWebhook(req.body).catch(e => console.warn('[creao] webhook failed', e.message))
})

// Dashboard: today's Creao summary as the webhook saved it, or null until one arrives.
app.get('/summary/today', requireSecret, (_req, res) => {
  res.json({ v: 1, summary: store.getDay(today())?.summary ?? null })
})

// Demo helper: trigger the end-of-day summary by hand.
app.post('/creao/summary', requireSecret, async (_req, res) => {
  try {
    const runId = await creao.runSummary(today())
    res.json({ runId })
  } catch (e) {
    console.warn('[creao] runSummary failed', (e as Error).message)
    res.status(502).json({ error: (e as Error).message })
  }
})

// Demo helper: replace the demo day with a fresh one, e.g. right before presenting. Only with DEMO_DATA=1.
if (config.demoData) {
  app.post('/demo/reset', requireSecret, (_req, res) => {
    demo.seedDemo()
    res.json({ ok: true })
  })
}

// Debug helper: test the matcher without the glasses. POST {"question":"..."}. Off in production.
if (config.debugRoutes) {
  app.post('/debug/match', requireSecret, async (req, res) => {
    const { match, log } = await matcher.findMatch(String(req.body?.question ?? ''))
    res.json({ answer: match ? answerMessage(match.record) : null, log })
  })
}

const server = http.createServer(app)

// Contract 1: phone socket at /ws?token=APP_TOKEN. Audio frames are ~100 ms (3,200 bytes); 64 KB is plenty.
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname !== '/ws') return socket.destroy()
  wss.handleUpgrade(req, socket, head, ws => {
    if (url.searchParams.get('token') !== config.appToken) {
      ws.send(JSON.stringify({ v: 1, type: 'error', code: 'unauthorized', message: 'Bad token' }))
      return ws.close(4001, 'unauthorized')
    }
    new Session(ws)
  })
})

// Reminders (stretch, spec 6.7): send each due reminder to every listening phone within 5 minutes of its time.
// After that it is missed: no stale backlog on reconnect or resume. The status stays on the record for the dashboard.
const REMINDER_WINDOW_MS = 5 * 60_000
setInterval(() => {
  const now = Date.now()
  for (const r of store.allRecords()) {
    if (!r.remindAt || r.reminderStatus || Date.parse(r.remindAt) > now) continue
    if (now - Date.parse(r.remindAt) > REMINDER_WINDOW_MS) {
      store.upsert({ ...r, reminderStatus: 'missed', reminderDoneAt: new Date().toISOString() })
      console.log(`[reminder] missed ${r.id} (due ${r.remindAt})`)
      continue
    }
    const msg = { ...answerMessage(r), at: formatTime(r.remindAt), day: undefined }
    let delivered = 0
    for (const s of sessions) if (!s.isPaused && s.send(msg)) delivered++
    if (!delivered) continue
    store.upsert({ ...r, reminderStatus: 'sent', reminderDoneAt: new Date().toISOString() })
    console.log(`[reminder] sent ${r.id} to ${delivered} phone(s)`)
  }
}, 15_000)

// Every 5 minutes: send new transcript, pairs, questions and tone to Creao's log agent. Never blocks anything live.
// The window ends 15 s ago, so tone results and matches still in flight land in the next batch instead of being missed.
const LOG_LAG_MS = 15_000
let lastLogAt = new Date(Date.now() - LOG_LAG_MS).toISOString()
setInterval(() => {
  const fromIso = lastLogAt
  const toIso = new Date(Date.now() - LOG_LAG_MS).toISOString()
  lastLogAt = toIso
  // The demo day stays out of Creao's history.
  const real = <T extends { id: string }>(xs: T[]) => xs.filter(x => !demo.isDemo(x.id))
  const { transcript, events, tones, pairs } = store.between(fromIso, toIso)
  const batch = { transcript: real(transcript), events: real(events), tones: real(tones), pairs: real(pairs) }
  if (!batch.transcript.length && !batch.events.length) return
  creao.submitLog({ fromIso, toIso, ...batch }).catch(e => console.warn('[creao] submitLog failed', e.message))
}, 5 * 60_000)

// Server-driven Creao runs (spec 8): daily summary and nightly patterns, once per local day, only within
// 15 minutes after their time. A server (re)started later that evening doesn't fire them, so a fresh store or a
// redeploy never spends credits on a surprise run; the last run date is persisted too. Missed or failed runs aren't
// retried automatically (each run costs credits); use POST /creao/summary.
const RUN_WINDOW_MIN = 15
const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
const localHHMM = () =>
  new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date())
const scheduled: [RunKind, string, (date: string) => Promise<string>][] = [
  ['summary', config.summaryAt, creao.runSummary],
  ['patterns', config.patternsAt, creao.runPatterns],
]
function scheduleTick() {
  const date = today()
  for (const [kind, at, run] of scheduled) {
    const sinceAt = minutesOf(localHHMM()) - minutesOf(at)
    if (sinceAt < 0 || sinceAt >= RUN_WINDOW_MIN || store.lastRun(kind) === date) continue
    store.setLastRun(kind, date)
    run(date).then(id => console.log(`[creao] ${kind} run ${id}`), e => console.warn(`[creao] ${kind} run failed`, e.message))
  }
}
setInterval(scheduleTick, 60_000)

// Idle check: close phones that sent nothing (no audio, no ping) for 45 s, so their speech streams close.
const MAX_IDLE_MS = 45_000
setInterval(() => { for (const s of sessions) s.closeIfIdle(MAX_IDLE_MS) }, 5_000)

// Expire yesterday's records; with DEMO_DATA, start a new demo day once the date turns over.
setInterval(() => {
  store.pruneExpired()
  if (config.demoData) demo.refreshIfStale()
}, 10 * 60_000)

// Health-check the tone service every 30 s while tone is on: /health must show an outage and a recovery
// (and the first start's model download) without waiting for the next question.
setInterval(() => { if (emotion.toneEnabled()) void emotion.probe() }, 30_000)
setInterval(() => { if (voices.voiceEnabled()) void voices.probe() }, 30_000)

// docker stop / Ctrl-C: save the store and exit instead of being killed mid-write.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    console.log(`[server] ${sig}, saving and exiting`)
    store.flush()
    process.exit(0)
  })
}

server.listen(config.port, () => {
  console.log(`[server] listening on :${config.port}  matcher=${matcherName}  verify=${verifierName}  speech=${config.speechProvider}`)
  if (config.speechRoleSource === 'glasses')
    console.log('[server] speaker roles from the glasses (phone `role` messages); loudness only where the phone sends none')
  if (config.speechRoleSource === 'loudness' && config.speechOptions.provider === 'elevenlabs' && config.speechOptions.wearerThresholdDb === undefined)
    console.warn('[server] WARNING: SPEECH_PROVIDER=elevenlabs but SPEECH_WEARER_THRESHOLD_DB is empty; every utterance will be "unknown", so no questions or answers are captured. Run npm run speech:calibrate.')
  if (config.speechOptions.provider === 'deepgram' && config.speechOptions.wearerThresholdDb === undefined && config.speechOptions.wearerSpeaker === undefined)
    console.warn('[server] WARNING: SPEECH_PROVIDER=deepgram with neither SPEECH_WEARER_THRESHOLD_DB nor SPEECH_WEARER_SPEAKER; every utterance will be "unknown". Calibrate a loudness threshold.')
  if (config.geminiApiKey && config.verifyProvider === 'stepfun' && (!config.stepfunApiKey || !config.stepfunModel))
    console.warn('[server] WARNING: VERIFY_PROVIDER=stepfun but STEPFUN_API_KEY or STEPFUN_MODEL is missing; every yes/no check will fail, so nothing will be answered.')
  console.log(`[server] tone=${config.toneUrl || 'not configured (set TONE_URL)'}`)
  void emotion.probe()
  console.log(`[server] voice=${config.voiceUrl || 'not configured (set VOICE_URL)'}${config.voiceUrl ? `  dashboard: ${config.publicUrl}/voices#key=<FACTS_SECRET>` : ''}`)
  void voices.probe()
  scheduleTick()
  if (matcherName === 'local') console.warn('[server] WARNING: no GEMINI_API_KEY or ANTHROPIC_API_KEY. The local matcher is for testing plumbing only and makes wrong matches. Never demo without the key.')
})
