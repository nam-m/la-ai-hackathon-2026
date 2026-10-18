import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import type { DaySummary, LogEntry, PatternsReport, QARecord, QuestionEvent, RunKind, ToneRecord, TranscriptLine } from './types.js'

/**
 * Q&A store: in memory, saved to a JSON file so it survives restarts.
 * Embeddings are cached here too so we only embed each question once.
 * Also keeps today's transcript, question events and tone records for the dashboard and Creao,
 * what Creao sends back (per-day log, summary, patterns) and the run ID -> kind registry.
 */
type Day = { log: LogEntry[]; summary?: DaySummary; patterns?: PatternsReport }
type StoreFile = {
  records: QARecord[]
  embeddings: Record<string, number[]>
  transcript: TranscriptLine[]
  events: QuestionEvent[]
  tones: ToneRecord[]
  settings: { toneAnalysis: boolean }
  days: Record<string, Day>
  runs: Record<string, RunKind>
  lastRun: Partial<Record<RunKind, string>> // local date of the last scheduled run per kind
}

const KEEP_DAYS = 7
const empty = (): StoreFile => ({
  records: [], embeddings: {}, transcript: [], events: [], tones: [], settings: { toneAnalysis: true }, days: {}, runs: {}, lastRun: {},
})
let data: StoreFile = empty()
let saveTimer: NodeJS.Timeout | null = null

export function loadStore() {
  try {
    data = { ...empty(), ...JSON.parse(fs.readFileSync(config.dataFile, 'utf8')) }
    console.log(`[store] loaded ${data.records.length} records`)
  } catch {
    console.log('[store] starting empty')
  }
  pruneExpired()
}

function writeFile() {
  fs.mkdirSync(path.dirname(config.dataFile), { recursive: true })
  const tmp = config.dataFile + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data))
  fs.renameSync(tmp, config.dataFile)
}

function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(() => { saveTimer = null; writeFile() }, 200)
}

/** Write any pending change now. Called on shutdown so the last 200 ms aren't lost. */
export function flush() {
  if (!saveTimer) return
  clearTimeout(saveTimer)
  saveTimer = null
  writeFile()
}

/** Local calendar date (YYYY-MM-DD) in the wearer's time zone. */
export function localDate(iso: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date(iso))
}
const today = () => localDate(new Date().toISOString())

/**
 * A record can still be shown: standing, a pending reminder, or answered today; and never past expiresAt.
 * Spoken records and non-standing facts expire at local midnight.
 */
const isLive = (r: QARecord) => {
  if (r.expiresAt && Date.parse(r.expiresAt) <= Date.now()) return false
  if (r.standing) return true
  if (r.remindAt) return Date.parse(r.remindAt) > Date.now() - 86_400_000
  return localDate(r.answeredAt) === today()
}

export function pruneExpired() {
  const before = data.records.length
  data.records = data.records.filter(isLive)
  const live = new Set(data.records.map(r => r.id))
  for (const id of Object.keys(data.embeddings)) if (!live.has(id)) delete data.embeddings[id]
  // Transcript, events, tone and Creao days are kept 7 days so patterns have history.
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000
  data.transcript = data.transcript.filter(l => Date.parse(l.at) >= cutoff)
  data.events = data.events.filter(e => Date.parse(e.at) >= cutoff)
  data.tones = data.tones.filter(t => Date.parse(t.at) >= cutoff)
  const oldest = localDate(new Date(cutoff).toISOString())
  for (const d of Object.keys(data.days)) if (d < oldest) delete data.days[d]
  if (data.records.length !== before) console.log(`[store] expired ${before - data.records.length} records`)
  scheduleSave()
}

export function upsert(record: QARecord) {
  const i = data.records.findIndex(r => r.id === record.id)
  if (i >= 0) {
    if (data.records[i].question !== record.question) delete data.embeddings[record.id]
    data.records[i] = record
  } else {
    data.records.push(record)
  }
  scheduleSave()
}

export function remove(id: string) {
  const before = data.records.length
  data.records = data.records.filter(r => r.id !== id)
  delete data.embeddings[id]
  scheduleSave()
  return data.records.length !== before
}

/** The current version of a record, if it is still showable. Checked again right before delivery. */
export function get(id: string) {
  const r = data.records.find(r => r.id === id)
  return r && isLive(r) ? r : undefined
}

export const allRecords = () => data.records
export const answerable = () => data.records.filter(r => r.question && isLive(r))

// ---- transcript, question events, tone, settings ----
const isToday = (iso: string) => localDate(iso) === today()

export function addTranscript(line: TranscriptLine) { data.transcript.push(line); scheduleSave() }
export function addEvent(e: QuestionEvent) { data.events.push(e); scheduleSave() }
export function updateEvent(id: string, patch: Partial<QuestionEvent>) {
  const e = data.events.find(x => x.id === id)
  if (e) { Object.assign(e, patch); scheduleSave() }
}
export function addTone(t: ToneRecord) {
  data.tones.push(t)
  updateEvent(t.questionEventId, { toneId: t.id })
  scheduleSave()
}
export const todaysTranscript = () => data.transcript.filter(l => isToday(l.at))
export const todaysEvents = () => data.events.filter(e => isToday(e.at))
export const todaysTones = () => data.tones.filter(t => isToday(t.at))
/** Everything stamped in (fromIso, toIso], for the 5-minute Creao log batch. ISO UTC strings compare correctly. */
export const between = (fromIso: string, toIso: string) => {
  const inRange = (iso: string) => iso > fromIso && iso <= toIso
  return {
    transcript: data.transcript.filter(l => inRange(l.at)),
    events: data.events.filter(e => inRange(e.at)),
    tones: data.tones.filter(t => inRange(t.at)),
    pairs: data.records.filter(r => r.source === 'spoken' && inRange(r.answeredAt)),
  }
}
export const getSettings = () => data.settings
export function setSettings(patch: Partial<StoreFile['settings']>) { Object.assign(data.settings, patch); scheduleSave() }
export const todaysSpokenPairs = () => data.records.filter(r => r.source === 'spoken' && isToday(r.answeredAt))
export const todaysReminders = () => data.records.filter(r => r.remindAt && isToday(r.remindAt))

export const getEmbedding = (id: string) => data.embeddings[id]
export function setEmbedding(id: string, vec: number[]) {
  data.embeddings[id] = vec
  scheduleSave()
}

let counter = 0
export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}`

// ---- Creao results (D's CreaoStore seam) ----

const day = (date: string) => (data.days[date] ??= { log: [] })

export function appendLogEntry(date: string, entry: LogEntry) { day(date).log.push(entry); scheduleSave() }
export function saveSummary(date: string, summary: DaySummary) { day(date).summary = summary; scheduleSave() }
/**
 * Filed under the local date the report covers, not the day the webhook arrives (spec 8). Uses the instant just
 * before toIso, so a period ending at local midnight counts as the day it closes, and a run-time toIso (23:30) as that day.
 */
export function savePatterns(report: PatternsReport) {
  const end = typeof report.toIso === 'string' ? Date.parse(report.toIso) : NaN
  const covered = Number.isNaN(end) ? today() : localDate(new Date(end - 1).toISOString())
  day(covered).patterns = report
  scheduleSave()
}
export const getDay = (date: string) => data.days[date]

/** D's RunKindRegistry: run ID -> kind, persisted so callbacks after a restart still route. */
export const runRegistry = {
  put(runId: string, kind: RunKind) { data.runs[runId] = kind; scheduleSave() },
  take(runId: string) { const k = data.runs[runId]; delete data.runs[runId]; scheduleSave(); return k },
  peek: (runId: string) => data.runs[runId],
  has: (runId: string) => runId in data.runs,
}

export const lastRun = (kind: RunKind) => data.lastRun[kind]
export function setLastRun(kind: RunKind, date: string) { data.lastRun[kind] = date; scheduleSave() }
