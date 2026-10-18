# Part 4 — Pipeline & Task Plan

**Owner:** D (Creao lead) · **Project:** Asked & Answered · **Scope:** Part 4 only
**Status:** planning — no implementation yet

---

## 0. Scope

Part 4 covers everything on the CREAO side: the three runtime agents, the caregiver
dashboard, and the plumbing that connects CREAO to C's server. It does **not** cover
the glasses app (A), the speech module (B), or the core server/matcher (C).

Everything here is bound by one rule from the team plan:

> **CREAO is never in the live answer path.** Runs are asynchronous with no promised
> speed. Nothing a user waits on may depend on a run completing.

---

## 1. Locked design decisions

These are settled before any code. Changing one invalidates downstream work.

### D1 — Runs are server-driven, not CREAO-scheduled

CREAO's scheduler delivers **email only**; `webhook_url` exists only on
`POST /v1/runs`. Therefore:

- C's server runs a **5-minute timer** and calls `POST /v1/runs` with a `webhook_url`.
- The nightly patterns run is a **server-side cron**, not a CREAO schedule.
- CREAO's Schedule tab is used for **nothing** in this project.

*Consequence:* if the server is down, no runs happen. That is acceptable — the server
is already the single point of contact.

### D2 — Personal agent + personal workspace only

The workspace-files and runs APIs require both the workspace and the agent to belong
to the **same Account API key owner**. Team workspaces return `WORKSPACE_NOT_FOUND`;
non-personal agents return `AGENT_NOT_FOUND`. The agent must also be **active**.

*Consequence:* create everything under the account that owns the `cr_sk_` key. Never
a team workspace.

### D3 — D's code is a mountable module, not a set of routes in C's file

`folder-structure.md` puts `server/src/index.ts` under C's ownership. D must not edit
it. Instead:

```
server/src/creao/
├── index.ts      # public functions C calls (already contracted)
├── client.ts     # raw API client (fetch wrapper, error mapping)
├── routes.ts     # Express router: POST /creao/webhook, POST /facts
├── prompts/      # agent prompt text, versioned as files
└── runs.ts       # run-kind registry + the server-side timer
```

C mounts one line:

```ts
app.use('/creao', creaoRoutes)
```

**This is the single most important anti-conflict decision.** It means D never touches
a file C owns, and C never touches a file D owns.

### D4 — Webhook handling is idempotent

Delivery is **at-least-once** with up to 3 attempts and a 10 s timeout. Dedupe on the
`X-Creao-Delivery-Id` header (falling back to `runId`). Respond `2xx` immediately, do
slow work after. A retry must never double-write a log entry or re-send facts.

### D5 — Model is chosen per run, not per agent

`POST /v1/runs` accepts an optional `model` field that overrides the agent's Default
model. The server picks the model per run kind. This keeps cost low for trivial runs
and quality high for analysis runs, without maintaining separate agents.

### D6 — Prefer text over audio on the wire (see R1)

B already produces a transcript. Uploading audio to CREAO adds a file-type risk, a
size-limit risk, and a transcription-capability risk for no new information **when
Deepgram is the provider** (it gives live speaker labels). Audio is only needed for
labels if ElevenLabs wins the loudness test. Decide this at W0, not at 4 AM.

---

## 2. Work breakdown

Dependencies are hard. "Done when" is the acceptance test.

| ID | Task | Depends on | Deliverable | Done when |
|---|---|---|---|---|
| **W0** | Access & unblock | — | `cr_sk_` key, personal `workspace_id`, 3 `agent_id`s, measured run duration | A test run completes and its webhook lands on a stub |
| **W1** | Freeze contracts | W0 | Run-kind enum, input schemas, routing map, `creao` module signature | C signs off; both sides code against it unchanged |
| **W2** | API client | W1 | `client.ts`: uploadFile, createRun, getRun, error mapping | Unit-tested against the real API with one clip |
| **W3** | Webhook handler | W1 | `routes.ts` — verify, dedupe, `2xx` fast, route by run kind | Replay the same `X-Creao-Delivery-Id` twice → one write |
| **W4** | Log & Summary agent | W0, W1 | Agent #1 live; prompt returns structured transcript + summary | A real clip (or transcript) yields a correct labeled log |
| **W5** | Clip pipeline | W2, W3, W4 | 5-min timer: buffer → encode → upload → run → webhook → store | Two consecutive clips land in the log unattended |
| **W6** | Facts sync | W1, W3 | Dashboard facts → `POST /facts` → C's store → glasses | A typed fact reaches the glasses in the demo |
| **W7** | Dashboard | W1 | Today's plan, visitors, standing facts, Q&A log, summary | Judge can read the day's repeats at a glance |
| **W8** | Q&A log to dashboard | W3, W7 | `GET /qa/today` → rendered in the dashboard | Spoken pairs appear without manual refresh |
| **W9** | Patterns agent | W4, W5 | Nightly server cron → agent #2 → flags via webhook | Two days of log produce a non-diagnostic flag |
| **W10** | Reminders agent *(stretch)* | W6 | Reminder → `POST /facts` with `remindAt` → timed `answer` | A reminder fires on the glasses at its time |

**Critical path:** W0 → W1 → W2/W3 → W4 → W5 → W6 → W7 → W8.
**W9 and W10 are off the critical path** — cut them first if time runs out. The team
plan already marks W10 stretch and W9 should-have.

---

## 3. Pipeline

Forward flow (server → CREAO → server):

```
C's server
  │  every 5 min (server-side timer)
  ├─ buffer the session's utterances / audio
  ├─ POST /v1/workspaces/{workspace_id}/files        (only if sending audio)
  ├─ POST /v1/runs  { agent_id, input, workspace_id, webhook_url, model }
  │        │
  │        ▼
  │   CREAO async run  (log | summary | patterns)
  │        │
  │        ▼
  └─ POST /creao/webhook  ◀── terminal callback (≤3 attempts, 10s timeout)
         │
         ├─ verify + dedupe on X-Creao-Delivery-Id
         ├─ 2xx immediately
         └─ route by run_id → { log, summary, facts, patterns }
                ├─ log      → append to day's log store
                ├─ summary  → dashboard end-of-day panel
                ├─ facts    → POST /facts → C's store → glasses
                └─ patterns → flags on dashboard
```

Reverse flow (dashboard → glasses):

```
Caregiver edits facts in the CREAO dashboard
        │
        ▼
POST /facts  (Authorization: Bearer <FACTS_SECRET>)
        │
        ▼
C's Q&A store  ──▶  glasses answer line
```

**Rule:** the reverse flow is also asynchronous. Nothing in the dashboard blocks the
live loop.

---

## 4. Build fleet — task division

Three workers, each owning **disjoint files**. The boundary is D3.

| Worker | Owns | Tasks | Files |
|---|---|---|---|
| **W-Server** | The CREAO integration | W1, W2, W3, W5 | `server/src/creao/client.ts`, `routes.ts`, `runs.ts`, `index.ts` |
| **W-Agents** | The three runtime agents | W4, W9, W10 | `server/src/creao/prompts/*` + the CREAO agents themselves |
| **W-Dash** | The family-facing surface | W6, W7, W8 | `dashboard/**` (new), plus the facts route in `routes.ts` via W1's interface |

**Handoff contracts between workers:**

- W-Server → W-Agents: the frozen run-kind enum and input schema (W1). W-Agents never
  edits `client.ts`.
- W-Server → W-Dash: `routes.ts` exports the facts route signature. W-Dash never edits
  `client.ts` or `routes.ts` internals.
- W-Agents → W-Server: the `agent_id` values and the exact `input` shape each agent
  expects. W-Server stores them in config, never hardcoded.

**Merge discipline (this matters on a clock):** each worker commits to its **own
branch**, opens a PR, and one person merges. Do not let two workers touch the same
file. If two workers need the same file, the interface in W1 is wrong — fix W1.

**If D is one person (as the team plan assumes):** run the workers as *sequential
phases* in the order above, not in parallel. W7 (dashboard) can start early against
mock data since it depends only on W1.

---

## 5. Setting up the agents

Two different kinds of agent. Do not conflate them.

### 5a. Build agents (who write the code)

These are CREAO agents that produce the Part 4 code. Create one per worker in section 4.

1. Open the create-agent dialog → choose **Workflow Agent** (multi-step work) — or run
   the work once in chat, then **Save as agent**.
2. Name it after its scope, e.g. `part4-creao-integration`, `part4-agents`,
   `part4-dashboard`.
3. Give it the worker's task list and the frozen contracts from W1 as its instructions.
4. Attach reference files (the four planning docs) on the **Files** tab so every run
   reads the same brief.
5. Set the **Default model** (see 5c).
6. Set **write autonomy** to **Auto** so it can push without stopping for approval on
   every action.
7. Note the `agent_id` — it is what `POST /v1/runs` needs.

**Critical:** the build agents write to **GitHub**, not to your Mac. Give them the repo
`nam-m/la-ai-hackathon-2026` and a branch per worker. Nothing needs device pairing.

### 5b. Runtime agents (the product)

These are the three agents the team plan promises. They are the *deliverable*, not the
builders. Full spec in section 6.

### 5c. Model choice

Agents run on their **Default model**, and `POST /v1/runs` can override per run.

| Agent | Recommended default | Why |
|---|---|---|
| Build: server integration | Strong (Sonnet-class) | Correct API error handling matters |
| Build: dashboard | Strong (Sonnet-class) | One-shot layout quality |
| Build: agents/prompts | Strong (Sonnet-class) | Prompt quality drives output quality |
| Runtime: Log & Summary | Mid/fast (Haiku or Gemini-class) | High volume, low reasoning need |
| Runtime: Patterns | Strong (Sonnet-class) | Cross-day reasoning; quality matters |
| Runtime: Reminders | Fast (Haiku-class) | Trivial routing |

Per-run override example: the 5-minute log runs use the cheap model; the 8 PM summary
run uses the strong one, on the **same agent**.

---

## 6. Runtime agents — specification

Three agents behind one CREAO app. The dashboard is the app's own screen on top of
them, not a fourth agent.

### Agent #1 — Log & Summary

- **Runs:** every 5 min (log) + 8 PM (summary) — both triggered by C's server
- **Input:** `{ kind: "log" | "summary", date, clipFile?, transcript?, qaPairs? }`
- **Output:** structured JSON — speaker-labeled transcript entries, or the end-of-day
  summary (which questions repeated, how often, what to flag)
- **Webhook run kind:** `log` or `summary`
- **Never:** diagnoses, or invents an answer

### Agent #2 — Patterns

- **Runs:** nightly server cron
- **Input:** `{ dateRange, logs: [...] }`
- **Output:** changes only — more repeats than usual, new worries, confusion at certain
  times. Flags for the family.
- **Webhook run kind:** `patterns`
- **Never:** diagnoses. This is a hard rule from the trust-and-safety section.

### Agent #3 — Reminders *(stretch)*

- **Runs:** on the family's schedule
- **Input:** `{ question: null, answer, remindAt }`
- **Path:** reaches C's store via `POST /facts` with `remindAt` set
- **Webhook run kind:** `facts`

### Shared rules (from the team plan — non-negotiable)

1. The AI never writes answers. It repeats what a person said or what the family typed.
2. Every answer carries who and when.
3. When unsure, show nothing.
4. Old answers expire; only `standing` facts persist.
5. Consent first.

---

## 7. Risks & open questions

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| **R1** | **Can a CREAO agent transcribe an uploaded audio file?** The whole log-agent design assumes yes. Not documented. | Blocks W4/W5 | **Test at W0.** Fallback: send B's text transcript instead of audio (D6). This is cheaper and sidesteps R2 and R3 entirely. |
| **R2** | **WAV may be rejected.** Workspace files accept "documents, images, spreadsheets, archives, code files"; Media is **MP4/WebM only**. WAV is not enumerated. | Blocks W2/W5 | Test at W0. Fallback: audio-only MP4/WebM, or text (R1 fallback). |
| **R3** | **5-min clip is ~9.2 MiB against a 10 MB cap.** 16 kHz × 2 B × 300 s = 9,600,000 B. | Silent failure at demo | Shorter clips, compression, or text. Assume 10 MB, not 100 MB. |
| **R4** | Run duration unknown | Timeline slip | Measure the first test run at W0; write it into the team plan's Open questions |
| **R5** | Server down → no runs | Stale dashboard | Acceptable; dashboard is not the live path |
| **R6** | Webhook retry double-writes | Corrupt log | D4 dedupe. Test by replaying a delivery id |
| **R7** | Facts secret leaked | Unauthorized fact injection | `FACTS_SECRET` server-side only, never in the app or the repo |
| **R8** | Team workspace used by mistake | `WORKSPACE_NOT_FOUND` | D2. Create the workspace personally, verify at W0 |

**Additional errors to handle beyond the build guide's list:** `WORKSPACE_NOT_FOUND`,
`WORKSPACE_MISMATCH` (409), `INVALID_INPUT`, `AGENT_NOT_FOUND`, `RUN_NOT_FOUND`.

**Rate limits:** 30 requests/account/minute across `/v1/*`, and 30 writes/hour for
agent/workspace/secret writes. A 5-minute cadence is 0.2 runs/min — comfortably inside.
Do not retry a failed `POST /v1/runs` in a tight loop; each accepted run costs credits.

---

## 8. Definition of done

Part 4 is done when all of these are true:

- [ ] A repeated question's answer reaches the glasses **without** any CREAO call in the path
- [ ] Family facts entered in the dashboard reach C's store and appear on the glasses
- [ ] The dashboard shows today's Q&A log and the end-of-day summary
- [ ] The 5-minute log pipeline runs unattended for 15 minutes with no manual step
- [ ] Replaying a webhook delivery id writes nothing twice
- [ ] `GET /health` passes and the log shows every run's kind, id, and outcome
- [ ] No secret is committed to the repo
- [ ] The CREAO key lives on the server only

---

## 9. Immediate next actions

1. **W0 (now):** create the personal workspace, get the `cr_sk_` key, run one test run
   with a `webhook_url`, and answer R1 + R2.
2. **W1:** freeze the run-kind enum and input schemas; get C to sign off.
3. **Set up the build agents** (section 5a) once W1 is frozen.
4. Only then start W2/W3.

**Do not write code before W0 answers R1.** If CREAO cannot transcribe audio, the
design of Agent #1 changes.
