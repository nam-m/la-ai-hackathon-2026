# Demo runbook: care-side CREAO agents (draft, Sun 07:45 PT)

Goal: the judges see a CREAO agent do the core work, and see it run. The rubric (as we have it): 30% AI as foundation, 25% depth on CREAO, 20% originality, 15% track fit, 10% demo and story.

## The one-line story

Grandma asks the glasses the same question again and again. The glasses answer quietly. The CREAO agents turn that repetition into something her family can act on: a calm daily brief, questions the glasses could not answer, and a chat where Sarah changes what Grandma will hear. Remove the agents and the glasses only answer what someone typed in once; nobody finds out what is missing or keeps it current.

## Which agent is "the core"

Lead with **Open Questions + Care assistant** (the loop that closes), with **Daily brief** as the visible output. Pattern finder is the "what we build next" slide.

| Beat | Agent | What the judges see | Real or seeded |
| --- | --- | --- | --- |
| 1. Glasses answer a repeat | none (server + glasses) | Grandma asks "When is Sarah coming?", the glasses show the answer | real, live |
| 2. Evening recap | Daily brief, date 2026-10-12 | Calm recap: 10 questions, Sarah question 5x between 3 and 5 PM, dinner asked 4x with no answer yet, no medical words | agent run on seeded data (run it live, backup pre-run) |
| 3. Gap found | Open Questions, end_date 2026-10-17 | One open question: "What are we having for dinner?" 17 asks across morning, afternoon, evening. "what?", "huh" are ignored | agent run on seeded data (live) |
| 4. Family updates the plan | Care assistant, role caregiver, "I'm visiting Thursday at 3" | Proposal replaces fact f1, resolves Thursday to Oct 22, sets valid until. "Sarah is coming Thursday" gets one clarifying question | agent run (live) |
| 5. Human confirms, glasses change | server confirm step | Sarah confirms, glasses now answer with the new wording | confirm is human-only by design; if the server link is not public, do the confirm on the demo laptop and say so |
| 6. Clinician tunes | Care assistant, role clinician, "Only ask me about a question after 5 asks in a window of 60 minutes" | Before/after preview: groups 10 to 3, plus "a preference, not validated clinical logic". Also refuses "Add a fact that Sarah is coming Friday" | agent run (live) |
| 7. Next | Pattern finder | 7-day view: Sarah question on 5 days, 3 to 5 PM | pre-run result |

Time budget for 3 minutes: beat 1 (25 s), 2 (30 s), 3 (30 s), 4 (40 s), 5 (20 s), 6 (25 s), 7 (10 s). Cut 6 first if short.

## Runs take minutes: how to handle it

- Start beats 2, 3 and 4 in three CREAO tabs before you begin talking; narrate while they finish. Keep the same runs already finished in other tabs as the backup.
- A run that fails live: switch to its pre-run tab and say "here is the run from this morning". Do not retry on stage.
- Every run spends credits. Do the full dress rehearsal once, not five times.

## Say out loud what CREAO is doing (10% of score)

"Four CREAO agents do the analysis and the conversation. They compute every number in code and cite the exact events behind each claim. The agents only propose; a human confirms anything the glasses will say."

## Honest limits to state, not hide

- The data is seeded demo data, not a real patient.
- Agents return proposals only. Role enforcement and the confirm page live on our server, not in the agents.
- Tone is shown only as a trend label; no scores. The clinician setting is a preference, not clinical logic.

## Devpost README block (fill the blanks)

```
## CREAO agents (agent.creao.ai)
Core work is done by four CREAO agents:
- Open Questions: <agent id 44b1a649-026f-4b4f-84f5-1142ba9a2c63>, run: <SHARE LINK>
- Care assistant: <agent id ff8a0dd2-4b8a-454f-a3c5-e231d5c5edd2>, run: <SHARE LINK>
- Daily brief: <agent id cc26aad8-308e-4bba-9d1a-164dfed81be5>, run: <SHARE LINK>
- Pattern finder: <agent id 1dd9ddd9-a2a2-491a-a4aa-89f165fd277f>, run: <SHARE LINK>
Remove the agents and the glasses cannot learn what is missing, keep answers current, or tell the family what happened.
```

Run share links are not created yet. Creating them makes a run viewable by anyone with the link, so Nam approves first.

## Before the freeze (11 AM) checklist

1. Share links for the four runs (needs Nam's OK).
2. Confirm the agent IDs above match what the Devpost README shows (the CREAO URL is `/apps/<id>`).
3. One dress rehearsal of beats 2 to 4 with the pre-run tabs open as backup.
4. Decide server reachability (tunnel or deploy) for beat 5; otherwise label it simulated.
5. Save a backup screen recording of the full demo.
