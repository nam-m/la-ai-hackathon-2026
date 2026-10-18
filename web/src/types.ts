// Shapes returned by the Rewind server (server/src/types.ts and the routes in server/src/index.ts).

export type QARecord = {
  id: string
  question: string | null // null for a reminder
  answer: string
  askedAt: string
  answeredAt: string
  answeredBy: string | null
  source: 'spoken' | 'family'
  standing: boolean
  remindAt?: string | null
  expiresAt?: string | null
}

/** POST /facts body item. */
export type FactInput = Pick<QARecord, 'id' | 'question' | 'answer' | 'answeredBy' | 'standing'> & {
  remindAt: string | null
  expiresAt: string | null
}

export type Ask = {
  at: string
  worry: number | null // 0..1, null = no tone reading
  shown: boolean
  contradiction: boolean
  answeredBy: string | null
  source: 'spoken' | 'family' | null
}

export type Repeated = { question: string; count: number; times: string[]; worry: (number | null)[]; asks?: Ask[] }

export type Contradiction = { questionEventId: string; at: string; question: string; spoken: QARecord | null; fact: QARecord | null }

export type LogToday = { v: 1; repeated: Repeated[]; contradictions: Contradiction[] }

export type Health = { ok: boolean; sessions: number; paused?: number }

export type Settings = { toneAnalysis: boolean }

/** D's Creao summary; only `summary` is relied on, the rest stays loose. */
export type DaySummary = { date: string; summary?: string; text?: string; generatedAt?: string } & Record<string, unknown>

// ---- CREAO agent results (server/src/creao, routes under /creao). Loose on purpose: only the fields shown are read. ----

export type OpenQuestion = {
  cluster_id: string
  canonical_question: string
  count: number
  distinct_times_of_day?: number
  suggested_answer?: string | null
}
export type OpenQuestionsResult = { open_questions?: OpenQuestion[]; generatedAt?: string } & Record<string, unknown>

export type Pattern = { cluster: string; days_seen: number; total_count: number; time_window?: string; note?: string }
export type PatternsResult = { patterns?: Pattern[]; insufficient_data?: boolean; generatedAt?: string } & Record<string, unknown>

/** What the Care assistant returns. It only proposes: nothing changes until a person approves. */
export type CareResult = {
  role?: 'caregiver' | 'clinician'
  intent?: string
  proposal?: { action?: string; replaces_fact_id?: string | null; question?: string; answer_wording?: string; valid_until?: string } | null
  clarifying_question?: string | null
  settings_change?: { key: string; from: unknown; to: unknown } | null
  preview?: { before?: unknown; after?: unknown } | null
  rejected_reason?: string | null
  note?: string | null
}
export type CareRun = { v: 1; status: 'running' | 'done' | 'failed'; result?: CareResult; error?: string }
