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
4. Not tested: whether a CREAO agent can call our server (POST /facts, /proposals) from its sandbox; CREAO dashboard form input; text/SMS connector. Only email scheduled-run delivery is documented.
5. The agents return proposals only. Nothing writes facts anywhere; the confirm page and server enforcement of roles are not built yet.

## Next steps

1. 10-minute test: can an agent call a public URL (webhook.site) from its sandbox? Decides whether the server link is live or demo-only.
2. Schedule Daily brief at 8 PM and email the caregiver (only after Nam approves).
