# Care-side agents: handoff (Sun 2026-10-18, ~07:20 PT)

Read this first if you are resuming on a different account.

## What exists

Four CREAO agents, built on Nam's CREAO account (team "Nam's team"), **personal and unpublished**. Teammates cannot see them. To resume on another account, recreate them from `AGENT_SPECS.md` plus `seed/` (about 10 minutes each: paste the creation prompt, the shared rules and the seed data as one message into CREAO chat; agent creation then builds a script, tests it and registers the agent).

| Agent | CREAO app id | Open |
| --- | --- | --- |
| Daily brief (v1.1.0) | cc26aad8-308e-4bba-9d1a-164dfed81be5 | https://agent.creao.ai/apps/cc26aad8-308e-4bba-9d1a-164dfed81be5 |
| Pattern finder (tone fix) | 1dd9ddd9-a2a2-491a-a4aa-89f165fd277f | https://agent.creao.ai/apps/1dd9ddd9-a2a2-491a-a4aa-89f165fd277f |
| Open Questions | 44b1a649-026f-4b4f-84f5-1142ba9a2c63 | https://agent.creao.ai/apps/44b1a649-026f-4b4f-84f5-1142ba9a2c63 |
| Care assistant (v1.1.0) | ff8a0dd2-4b8a-454f-a3c5-e231d5c5edd2 | https://agent.creao.ai/apps/ff8a0dd2-4b8a-454f-a3c5-e231d5c5edd2 |

Seed data is embedded in each agent as reference data (pasted inline; file attach was not used). Nothing is scheduled, published, shared or connected to email/SMS.

## Files in this folder

- `AGENT_SPECS.md`: shared rules, four creation prompts, output JSON schemas, defaults, test table.
- `seed/`: `day-2026-10-11.json` to `day-2026-10-17.json`, `facts.json`, `expected.json` (ground truth for evals).
- `HANDOFF.md`: this file.

## Test results (run in CREAO against the seed)

| Agent | Case | Result |
| --- | --- | --- |
| Daily brief | 10-12 | PASS. 10 wearer questions; Sarah question 5x between 15:13 and 16:21, answered by f1; dinner 4x, no fact; "other" speaker line ignored; no banned words. |
| Daily brief | 10-17 | PASS after fix. 0 usable wearer questions, 4 low-quality excluded, summary says "not enough data to describe a pattern today". |
| Pattern finder | end 10-17, 7 days | PASS with a note. Sarah: 5 days, 24 asks, 15:00-17:00. It also reports dinner (5 days, 17 asks, window 10:00-18:00); `expected.json` lists only Sarah, so update the expectation (dinner does repeat across 5 days but has no tight window). |
| Pattern finder | end 10-16, 2 days | PASS. `insufficient_data: true`, "not enough data". |
| Open Questions | end 10-17 | PASS. One open question: dinner, 17 asks, 3 times of day, no suggested answer; "what?", "huh", "ok", "um" suppressed as fragments; "Where are my slippers?" suppressed as one-off; Sarah question not raised. |
| Open Questions | dismissed `oq-dinner` | PASS. Nothing raised; dinner listed under suppressed with reason `dismissed`. |
| Care assistant | caregiver "I'm visiting Thursday at 3" | PASS. Replaces f1, Thursday = 2026-10-22 3 PM, `valid_until` 2026-10-22T18:00:00. |
| Care assistant | caregiver "Sarah is coming Thursday" | PASS. No proposal; one clarifying question about the time. |
| Care assistant | clinician "repeated after 2 asks" | PASS. `repeat_threshold_count` 3 to 2 with before/after preview and the "preference, not validated clinical logic" note. |
| Care assistant | clinician "Add a fact that Sarah is coming Friday" | PASS. Refused. |
| Care assistant | caregiver "Turn tone tracking off" | PASS. Refused, points to clinician role. |

## Known issues to fix or accept

1. FIXED 07:35 PT: Pattern finder `tone_trend` is now one label (steady / more worried / less worried / not enough data), no raw counts. Sarah cluster comes out "more worried" at a gap of exactly 0.25 (3/12 to 6/12 worry flags), right at the threshold; treat as sensitive wording.
2. FIXED 07:35 PT: Care assistant clinician preview now shows per-day Daily brief repeat-group counts before/after plus total, with a one-sentence note. Caveat: "repeat after 2 asks" changes nothing on the seed (all groups already have 3+ asks, 10 before and 10 after); "5 asks in 60 minutes" drops groups from 10 to 3. Use the second case in the demo.
3. Daily brief tone trend for the Sarah group on 10-12 is "more worried" from one worry flag in the later half of 5 observations. Sensitive wording for a caregiver; consider requiring 6+ observations or a 0.4 gap before saying it.
4. Server link: BUILT (Sun 10:45 to 11:00 PT). The server starts the agents through each agent's `capi_` trigger key (`CAPI_KEY_*` env vars, `server/src/creao/`): Daily brief at 20:00 and Pattern finder at 23:30 (or `POST /creao/summary`, `POST /creao/patterns`), Open Questions every 30 minutes when new questions arrived (`OPEN_QUESTIONS_EVERY_MIN`), and the Care assistant on request (`POST /creao/care`). Results are saved on the server and shown in the family app (`web/`, Today tab). A run takes about 40 seconds or more, so nothing waits on one. Tested against a mock of the trigger API and in a headless browser; the real agents have not yet been confirmed to read the server's `data_json` input (each agent needs the `data_json` edit in CREAO chat), so until then a live run may fall back to seed data or ask for missing fields.
5. The agents return proposals only. A person approves in the family app (Approve and save posts to `POST /facts`) or with `approve-proposal.mjs`. Care team (clinician) output is a preview only; nothing applies a setting.

## Next steps

1. Paste the `data_json` edit into each agent in CREAO chat (text in this folder's history: add one optional `data_json` input, use it instead of the seed files when given, keep outputs unchanged), then run one real call per agent and check the output has `schema_version`.
2. Deploy the server, set the four `CAPI_KEY_*` values and `FACTS_SECRET` on the host (never in the repo), sign the family app in with the key.
3. One full rehearsal, then create the install links and a run link, and fill the Devpost block.
4. Schedule is automatic (summary 20:00, patterns 23:30, open questions every 30 minutes). Keep credits in mind: each run costs.
