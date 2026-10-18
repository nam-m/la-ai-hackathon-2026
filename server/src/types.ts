// Shapes from the build guide's API contracts. Change only with the other side's OK.

/** Contract: Q&A record. One shape for spoken pairs and family facts. */
export type QARecord = {
  id: string
  question: string | null // null for a reminder
  answer: string
  askedAt: string // ISO
  answeredAt: string // ISO
  answeredBy: string | null
  source: 'spoken' | 'family'
  standing: boolean
  remindAt?: string | null // ISO, stretch: reminders
  reminderStatus?: 'sent' | 'missed' // unset while scheduled; kept so the dashboard can show it
  reminderDoneAt?: string // ISO, when it was sent or marked missed
  expiresAt?: string | null // ISO, optional expiry for family facts
}

/** One finished sentence, kept for the dashboard log and Creao. */
export type TranscriptLine = { id: string; at: string; role: 'wearer' | 'other' | 'unknown'; name: string | null; text: string }

/** Every wearer question, counted separately from stored answers (so summaries can say "asked 4 times"). */
export type QuestionEvent = {
  id: string
  at: string
  question: string
  matchedRecordId: string | null // what the glasses showed, if anything
  matchScore: number | null
  answerRecordId?: string // set when this ask got answered aloud and became a stored pair
  toneId?: string
  contradiction?: { spokenRecordId: string; factRecordId: string } // nothing shown; the family should fix the fact
}

/** Estimated tone of voice for one wearer question. Family dashboard only. */
export type ToneRecord = {
  id: string
  questionEventId: string
  at: string
  provider: string // e.g. "emotion2vec/emotion2vec_plus_base"
  scores: Record<string, number>
  top: string[]
  worry: number // fearful + sad, 0..1: the single number trends are drawn from
  quality: 'ok' | 'too_short' | 'too_quiet' | 'failed'
}

/** Contract 1: phone to server (JSON frames; audio is binary). */
export type PhoneMessage =
  | { v: 1; type: 'hello'; session: string; source: 'glasses' | 'phone' }
  | { v: 1; type: 'control'; action: 'pause' | 'resume' }
  | { v: 1; type: 'ping' }

/** Contract 1: server to phone. */
export type ServerMessage =
  | { v: 1; type: 'answer'; id: string; text: string; speaker: string | null; at: string; source: 'spoken' | 'family' }
  | { v: 1; type: 'clear' }
  | { v: 1; type: 'status'; text: string }
  | { v: 1; type: 'pong' }
  | { v: 1; type: 'error'; code: 'stt_down' | 'bad_audio' | 'unauthorized'; message: string }

/**
 * D's Creao contract (feat/creao-01-contracts, server/src/creao/types.ts), the parts C's store needs.
 * Copied until that branch merges; summary/report stay loose so D's richer types still fit.
 */
export type RunKind = 'log' | 'summary' | 'facts' | 'patterns'
export type LogEntry = { at: string; speaker: string | null; name: string | null; text: string; isWearer: boolean }
export type DaySummary = { date: string } & Record<string, unknown>
export type PatternsReport = Record<string, unknown>

/** Contract 4: POST /facts body. */
export type FactInput = {
  id: string
  question: string | null
  answer: string
  answeredBy: string | null
  standing: boolean
  remindAt: string | null
  expiresAt?: string | null
}
