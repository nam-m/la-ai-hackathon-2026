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
