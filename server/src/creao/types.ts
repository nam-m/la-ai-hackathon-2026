/**
 * Asked & Answered — CREAO integration contracts (FROZEN)
 * ---------------------------------------------------------------
 * Owner: D (Creao lead) · Branch: feat/creao-01-contracts
 * Contract version: 1
 *
 * This file is the single seam between D's code and C's server. Everything
 * else in `server/src/creao/` may change freely; this file may not.
 *
 * RULES
 *  1. Changing anything here requires bumping CONTRACT_VERSION and getting
 *     C's explicit sign-off. Both sides code against this file unchanged.
 *  2. D never edits a file owned by C. C mounts D's router with one line:
 *         app.use("/creao", createCreaoRouter({ factsSecret, store }));
 *  3. CREAO is never in the live answer path. Nothing here may be awaited by
 *     a request a user is waiting on.
 *  4. No secret is ever imported from this file. Values arrive via config.
 *
 * Provenance: shapes below are taken from the team's Build Guide contracts
 * 1–6 and from CREAO's developer API reference (POST /v1/runs, the workspace
 * files API, and async terminal webhooks).
 */

/* ------------------------------------------------------------------ *
 * 0. Version
 * ------------------------------------------------------------------ */

export const CONTRACT_VERSION = 1 as const;

/* ------------------------------------------------------------------ *
 * 1. Run kinds — the routing vocabulary
 * ------------------------------------------------------------------ */

/**
 * Every async run D starts is tagged with exactly one kind. The kind is what
 * the webhook router switches on, and it is what the run_id -> kind registry
 * stores so an incoming callback can be attributed to the right agent.
 */
export const RUN_KINDS = ["log", "summary", "facts", "patterns"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/** Run kinds that are driven by a server-side timer rather than a user action. */
export const SCHEDULED_RUN_KINDS = ["log", "summary", "patterns"] as const;

/* ------------------------------------------------------------------ *
 * 2. CREAO API — request/response surface
 * ------------------------------------------------------------------ */

export type CreaoRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** A webhook is only ever sent for a terminal state. */
export const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly CreaoRunStatus[];

/** Terminal async callback payload delivered to POST /creao/webhook. */
export interface CreaoWebhookPayload {
  runId: string;
  status: CreaoRunStatus;
  /** Present for compatibility; equal to conversationId in current payloads. */
  threadId?: string;
  /** The public conversation identifier. */
  conversationId?: string;
  model?: string | null;
  /** Present when status is "completed". */
  result?: {
    text?: string;
    [key: string]: unknown;
  };
  /** Present when status is "failed". */
  error?: { code: string; message: string };
}

/**
 * Headers CREAO sends on every webhook attempt. Dedupe on deliveryId: delivery
 * is at-least-once, so the same payload can arrive more than once.
 */
export const WEBHOOK_HEADERS = {
  deliveryId: "x-creao-delivery-id",
  contentType: "content-type",
} as const;

/** Response of POST /v1/runs (202). */
export interface CreateRunResponse {
  run_id: string;
  status: CreaoRunStatus;
  agent_id: string | null;
  conversation_id: string | null;
  model: string | null;
  workspace_id?: string | null;
}

/** Response of POST /v1/workspaces/{workspace_id}/files (201). */
export interface UploadFileResponse {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

/** Documented error codes D must handle. */
export const CREAO_ERROR_CODES = {
  WORKSPACE_NOT_FOUND: "WORKSPACE_NOT_FOUND",
  WORKSPACE_MISMATCH: "WORKSPACE_MISMATCH",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  UNSUPPORTED_FILE_TYPE: "UNSUPPORTED_FILE_TYPE",
  INVALID_INPUT: "INVALID_INPUT",
  AGENT_NOT_FOUND: "AGENT_NOT_FOUND",
  RUN_NOT_FOUND: "RUN_NOT_FOUND",
  MODEL_NOT_SUPPORTED: "MODEL_NOT_SUPPORTED",
  MODEL_NOT_ALLOWED: "MODEL_NOT_ALLOWED",
  RATE_LIMITED: "RATE_LIMITED",
} as const;

export type CreaoErrorCode =
  (typeof CREAO_ERROR_CODES)[keyof typeof CREAO_ERROR_CODES];

/** Shape of an API error body. */
export interface CreaoErrorShape {
  code: CreaoErrorCode | string;
  message: string;
}

/* ------------------------------------------------------------------ *
 * 3. Domain types — shared with A, B and C
 * ------------------------------------------------------------------ */

/**
 * One finished sentence, as produced by B's speech module (Build Guide
 * contract 2). Kept identical to that contract so no translation is needed.
 */
export interface Utterance {
  id: string;
  text: string;
  /** Milliseconds from session start. */
  startMs: number;
  endMs: number;
  rmsDb: number;
  /** Provider label, or null when the provider gives no labels. */
  speaker: string | null;
  /** Family name if known. */
  name: string | null;
  isWearer: boolean;
}

/** A matched question and the answer a person gave it (Build Guide contract 2). */
export interface QAPair {
  question: Utterance;
  answer: Utterance;
}

/**
 * The one record shape the store keeps for both spoken pairs and family facts
 * (Build Guide, "Q&A record").
 */
export interface QARecord {
  id: string;
  question: string;
  answer: string;
  askedAt: string;
  answeredAt: string;
  answeredBy: string;
  source: "spoken" | "family";
  standing: boolean;
}

/** A family-entered fact, as accepted by C's POST /facts (contract 4). */
export interface FactInput {
  id: string;
  /** null when this entry is a reminder rather than a question/answer. */
  question: string | null;
  answer: string;
  answeredBy: string;
  standing: boolean;
  /** ISO time for reminders (stretch); null otherwise. */
  remindAt: string | null;
}

/** One line in the day's log, as emitted by agent #1. */
export interface LogEntry {
  at: string;
  speaker: string | null;
  name: string | null;
  text: string;
  isWearer: boolean;
}

/** End-of-day summary produced by agent #1's summary run. */
export interface DaySummary {
  date: string;
  repeatedQuestions: Array<{
    question: string;
    count: number;
    lastAnswer: string;
  }>;
  /** Human-readable observations for the family. Never a diagnosis. */
  flags: string[];
  generatedAt: string;
}

/**
 * A change agent #2 noticed across days. Advisory only.
 *
 * HARD RULE: agents never diagnose. A flag describes an observation and
 * points the family at it; it never names or implies a medical condition.
 */
export interface PatternFlag {
  kind:
    | "more_repeats"
    | "new_worry"
    | "time_of_day_confusion"
    | "other";
  detail: string;
  observedOn: string;
  /** What it is being compared against, when there is a baseline. */
  baseline?: string;
}

export interface PatternsReport {
  fromIso: string;
  toIso: string;
  flags: PatternFlag[];
  generatedAt: string;
}

/* ------------------------------------------------------------------ *
 * 4. Run inputs — what the server sends as POST /v1/runs `input`
 * ------------------------------------------------------------------ */

/**
 * Agent #1, log run.
 *
 * Prefer `transcript` over `clipFile`. When the speech provider supplies
 * speaker labels (Deepgram), the text is already labelled and sending audio
 * adds a file-type risk, a size-limit risk, and a redundant transcription.
 * `clipFile` exists only for the ElevenLabs case, where labels must come from
 * a batch model.
 */
export interface LogRunInput {
  kind: "log";
  /** Wearer's local day, ISO date. */
  date: string;
  /** Display name of an audio file already uploaded to the workspace. */
  clipFile?: string;
  /** Preferred path: labelled utterances already produced by B. */
  transcript?: Utterance[];
  /** Today's matched pairs, for cross-checking the log. */
  qaPairs?: QARecord[];
  sessionId?: string;
}

/** Agent #1, summary run (8 PM). */
export interface SummaryRunInput {
  kind: "summary";
  date: string;
  log?: LogEntry[];
  qaPairs?: QARecord[];
}

/** Agent #2, patterns run (nightly). */
export interface PatternsRunInput {
  kind: "patterns";
  fromIso: string;
  toIso: string;
  logs: Array<{ date: string; entries: LogEntry[] }>;
}

/**
 * Facts run. Used when the dashboard's facts are returned by a run rather
 * than written directly to C's store.
 */
export interface FactsRunInput {
  kind: "facts";
  date: string;
  facts: FactInput[];
}

/** Discriminated union of everything D can send as a run input. */
export type RunInput =
  | LogRunInput
  | SummaryRunInput
  | PatternsRunInput
  | FactsRunInput;

/* ------------------------------------------------------------------ *
 * 5. Routed results — what the webhook router dispatches
 * ------------------------------------------------------------------ */

export type RoutedResult =
  | { kind: "log"; entries: LogEntry[] }
  | { kind: "summary"; summary: DaySummary }
  | { kind: "facts"; facts: FactInput[] }
  | { kind: "patterns"; report: PatternsReport };

/* ------------------------------------------------------------------ *
 * 6. Configuration
 * ------------------------------------------------------------------ */

export interface CreaoConfig {
  /** cr_sk_ Account API key. Server-side only. */
  apiKey: string;
  /** Must be a PERSONAL workspace owned by the same account as the key. */
  workspaceId: string;
  /** Public https URL. localhost and private ranges are rejected by CREAO. */
  webhookUrl: string;
  /** Personal, active agent ids, one per run kind that starts a run. */
  agents: Partial<Record<RunKind, string>>;
  /** Shared secret for C's POST /facts. */
  factsSecret: string;
  /** Per-run model override. Omitted kinds use the agent's Default model. */
  modelByKind?: Partial<Record<RunKind, string>>;
  /** Base URL. Overridable for testing. */
  baseUrl?: string;
}

/** CREAO's documented base URL. */
export const CREAO_BASE_URL = "https://developer.creao.ai";

/* ------------------------------------------------------------------ *
 * 7. Run registry — run_id -> kind
 * ------------------------------------------------------------------ */

/**
 * The server starts a run and remembers its id. When the callback arrives,
 * the id is the only thing that says which agent produced it, so the registry
 * must be written before the run is started and must survive a restart.
 */
export interface RunKindRegistry {
  put(runId: string, kind: RunKind): Promise<void> | void;
  take(runId: string): Promise<RunKind | undefined> | RunKind | undefined;
  peek(runId: string): Promise<RunKind | undefined> | RunKind | undefined;
  has(runId: string): Promise<boolean> | boolean;
}

/* ------------------------------------------------------------------ *
 * 8. Store seam — what D needs from C's store
 * ------------------------------------------------------------------ */

/**
 * The narrow slice of C's store that D writes into. C implements this; D
 * never reaches past it.
 */
export interface CreaoStore {
  appendLogEntry(date: string, entry: LogEntry): Promise<void>;
  saveSummary(date: string, summary: DaySummary): Promise<void>;
  savePatterns(report: PatternsReport): Promise<void>;
  saveFacts(facts: FactInput[]): Promise<void>;
  /** Read today's pairs for the dashboard (contract 4, GET /qa/today). */
  getQaToday(): Promise<QARecord[]>;
}

/* ------------------------------------------------------------------ *
 * 9. Module signature — Build Guide contract 5
 * ------------------------------------------------------------------ */

export interface ClipRange {
  fromIso: string;
  toIso: string;
}

/**
 * `server/src/creao/index.ts` exports these four functions. Nothing here is
 * ever awaited in the live answer path.
 */
export interface CreaoModule {
  /**
   * Upload a buffered clip and start a log run.
   * @param wav 16 kHz mono WAV. Note the 10 MB workspace upload cap.
   * @returns the CREAO run id.
   */
  submitClip(wav: Buffer, range: ClipRange): Promise<string>;

  /** Start the end-of-day summary run. Returns the run id. */
  runSummary(dateIso: string): Promise<string>;

  /** Start the nightly patterns run. Returns the run id. */
  runPatterns(dateIso: string): Promise<string>;

  /** Handle a terminal webhook. Must be idempotent. */
  handleWebhook(body: unknown): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * 10. Route contract — the one line C adds
 * ------------------------------------------------------------------ */

export interface CreaoRouterOptions {
  factsSecret: string;
  store: CreaoStore;
  /** Called for every accepted facts payload. Defaults to store.saveFacts. */
  onFacts?: (facts: FactInput[]) => Promise<void>;
  /** Clock injection, so tests can pin "today". */
  now?: () => Date;
}

/**
 * `server/src/creao/routes.ts` exports:
 *
 *     export function createCreaoRouter(opts: CreaoRouterOptions): Router
 *
 * It serves:
 *   POST /creao/webhook   terminal callbacks   (verified + deduped, 2xx fast)
 *   POST /facts           facts from the dashboard   (Bearer <factsSecret>)
 *
 * C mounts it once and never edits inside it:
 *
 *     import { createCreaoRouter } from "./creao/routes";
 *     app.use("/creao", createCreaoRouter({ factsSecret: process.env.FACTS_SECRET!, store }));
 */
export interface CreaoRouterContract {
  createCreaoRouter(opts: CreaoRouterOptions): unknown;
}

/** Route paths D owns, relative to the mount point. */
export const CREAO_ROUTES = {
  webhook: "/webhook",
  facts: "/facts",
} as const;

/* ------------------------------------------------------------------ *
 * 11. Type guards — the webhook body is untrusted input
 * ------------------------------------------------------------------ */

export function isRunKind(value: unknown): value is RunKind {
  return (
    typeof value === "string" &&
    (RUN_KINDS as readonly string[]).includes(value)
  );
}

export function isCreaoWebhookPayload(
  value: unknown,
): value is CreaoWebhookPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.runId !== "string" || v.runId.length === 0) return false;
  if (typeof v.status !== "string") return false;
  return (
    v.status === "pending" ||
    v.status === "running" ||
    v.status === "completed" ||
    v.status === "failed" ||
    v.status === "cancelled"
  );
}

export function isTerminalStatus(
  status: CreaoRunStatus,
): status is (typeof TERMINAL_RUN_STATUSES)[number] {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

export function isFactInput(value: unknown): value is FactInput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    (v.question === null || typeof v.question === "string") &&
    typeof v.answer === "string" &&
    typeof v.answeredBy === "string" &&
    typeof v.standing === "boolean" &&
    (v.remindAt === null || typeof v.remindAt === "string")
  );
}

/**
 * Parse a run's `result` payload into a typed routed result.
 * Returns null when the payload does not match the expected shape, so the
 * caller can log and drop rather than write garbage.
 */
export function parseRunResult(
  kind: RunKind,
  result: CreaoWebhookPayload["result"],
): RoutedResult | null {
  if (!result || typeof result !== "object") return null;
  const data = (result as Record<string, unknown>).data ?? result;

  switch (kind) {
    case "log": {
      const entries = (data as { entries?: unknown }).entries;
      return Array.isArray(entries)
        ? { kind: "log", entries: entries as LogEntry[] }
        : null;
    }
    case "summary": {
      const summary = (data as { summary?: unknown }).summary ?? data;
      return summary && typeof summary === "object"
        ? { kind: "summary", summary: summary as DaySummary }
        : null;
    }
    case "facts": {
      const facts = (data as { facts?: unknown }).facts;
      return Array.isArray(facts)
        ? { kind: "facts", facts: (facts as unknown[]).filter(isFactInput) }
        : null;
    }
    case "patterns": {
      const report = (data as { report?: unknown }).report ?? data;
      return report && typeof report === "object"
        ? { kind: "patterns", report: report as PatternsReport }
        : null;
    }
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/* ------------------------------------------------------------------ *
 * 12. Limits — measured against CREAO's documented caps
 * ------------------------------------------------------------------ */

export const CREAO_LIMITS = {
  /** Workspace upload cap (Volume accounts get 100 MB). */
  workspaceUploadBytes: 10 * 1024 * 1024,
  /** Input JSON cap on POST /v1/runs. */
  runInputBytes: 256 * 1024,
  /** Requests per account per minute across /v1/*. */
  requestsPerMinute: 30,
  /** Webhook attempts before CREAO gives up. */
  webhookAttempts: 3,
  /** Webhook response timeout, in seconds. */
  webhookTimeoutSeconds: 10,
} as const;

/**
 * Audio budget check. 16 kHz mono 16-bit PCM is 32,000 bytes per second, so a
 * 5-minute clip is ~9.2 MiB — only ~4% under the default upload cap.
 */
export function pcm16Bytes(durationSeconds: number, sampleRate = 16000): number {
  return durationSeconds * sampleRate * 2;
}

export function fitsUploadBudget(
  durationSeconds: number,
  sampleRate = 16000,
): boolean {
  return pcm16Bytes(durationSeconds, sampleRate) <= CREAO_LIMITS.workspaceUploadBytes;
}
