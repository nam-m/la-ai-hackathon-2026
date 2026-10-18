# Asked & Answered / Rewind — Full product spec

Version 3.0 · 17 October 2026 · Concise edition

## 1. Scope and principles

Extend the complete `MVP_IMPLEMENTATION_SPEC.md` with all nine dementia-support modules below. Preserve G2 input, ElevenLabs transcription, voice cues, Q&A, facts, CREAO agents, logs, summaries, patterns and reminders. Recheck repository Markdown when implementation begins.

Help people retrieve trusted information, pursue chosen activities and communicate preferences; help supporters coordinate care and develop skills. Start with supported use by adults with mild-to-moderate dementia. Suitability depends on individual communication, accessibility and support needs.

Evidence for a facilitated intervention does not automatically validate its app equivalent. Describe these features as evidence-informed support; do not claim diagnosis, restored cognition or proven treatment effectiveness. Voice cues estimate expression, not internal mood. Declining is valid; fewer repeated questions alone is not a clinical success measure.

## 2. Shared experience

Use G2 for brief cues and the companion for media, longer instructions, planning and consent. Do not assume glasses audio output; verify a phone/earbud route for music or speech.

Present one action at a time, familiar wording and clear start/repeat/pause/stop/skip/help controls. Avoid memory quizzes as access gates, performance rankings, streak pressure and shaming. Configure language, cue length and accessibility with the person.

Sessions follow ready → active ↔ paused → completed/stopped, with declined/expired alternatives. Completion requires an explicit report with its author; delivery, elapsed time and app closure are not completion. One activity can serve multiple modules but creates one session.

One scheduler handles reminders and invitations. Check consent, approved content, preferences, helper prerequisites, quiet hours and existing sessions before delivery. Deduplicate and expire stale invitations. Proposed defaults: at most three optional invitations daily; no backlog after reconnect. User pause takes priority; user-requested access remains available during quiet hours.

## 3. Required support modules

| Module | Implement | Acceptance and boundaries |
|---|---|---|
| **Personalized cognitive rehabilitation** | Person-chosen everyday goals; baseline task observations; ordered approved cues; assistance levels; goal reviews; versioned professional plans | Demonstrate goal → cue → pause → reported assistance → review. Unreviewed steps cannot reach the wearer. Do not invent therapy intervals, hazardous tasks or cognitive scores. Evidence concerns selected everyday goals, not general cognitive restoration [E2]. |
| **Cognitive stimulation** | Reviewed, original/licensed activity catalog; individual/group facilitator view; scheduling, attendance, adaptations and pass/skip | Record facilitator/content version; no ranking or penalty for skipping. A named CST program requires its manual/license, qualified delivery and fidelity records. Generic puzzles are not equivalent to established programs [E1,E3]. |
| **Caregiver coping and skills** | Reviewed lessons on communication, repetition, stress and problem-solving; practice scenarios; private reflections; accepted support-task board | Other caregivers cannot access private reflections through UI/API/export/events. Proposed help is not covered until accepted. Do not claim an abbreviated app lesson reproduces START [E4]. Explicit reports of sudden confusion receive reviewed urgent-assessment guidance [E12]. |
| **Written cues and memory aids** | Existing Q&A/facts plus Today board, large-type/printable cues, optional exact-text read-aloud, source/review dates and conflict handling | Updates invalidate digital cues; printed cards show generation/review dates. Preserve negations and source text. Sensitive facts use agreed wording; never invent comforting memories or current medication advice [E5]. |
| **Routines and meaningful activities** | Interests, familiar roles and avoidances; flexible routine windows; materials/place/helper prerequisites; skip/reschedule | Assisted activities require confirmed support. Repeated decline pauses invitations for review without labeling deterioration. A reminiscence routine counts once [E1,E6]. |
| **Reminiscence** | Approved photos, recordings and captions with contributor, permission, approximate dates and avoided topics; optional facilitated sessions | New media requires review; hide/stop works immediately across modules. Use open conversation prompts, not recall tests. Never invent identities/history or impersonate a deceased relative [E7]. |
| **Music-based support** | Preferred/avoided music, authorized media, explicit start/stop, bounded volume and companion output; separate therapist-managed program | Playback is excluded from wearer Q&A/emotion analysis unless a tested attribution path distinguishes it. No autoplay from inferred sadness. Playlists do not inherit music-therapy claims [E8]. |
| **Movement, nutrition and social connection** | Human-approved movement/assistance plans; meal preferences, restrictions and helper tasks; approved contacts and accepted visits/calls | Block unsupported assisted movement and conflicting intake reminders for review. No AI exercise dosing, universal hydration targets or supplements. Chatbot use is not human social contact; proposed visits are not completed contact [E9,E10]. |
| **Sleep support** | Cross-module quiet hours, chosen evening routines, optional diary, descriptive trends and selected export | Preserve unknown values and self/observer provenance. No sleep-stage inference from silence, automatic nap restriction or medication changes. Quiet hours survive DST/reconnect while requested answers remain available [E1,E11]. |

Cochrane reviews indicate small or context-dependent benefits for several interventions, with uncertainty for some outcomes. Reminiscence effects vary by setting; music interventions may improve depressive symptoms at treatment end without establishing broad or lasting benefit. Preserve these limits in product claims.

## 4. Voice cues and optional conversation

Inherit all MVP consent, attribution, quality, uncertainty and staleness rules. Evaluate ElevenLabs' accessible acoustic signals first; use a verified audio-analysis fallback if structured live observations are unavailable. Transcript sentiment and expressive TTS are not substitutes for acoustic measurements.

Keep self-report, caregiver report and acoustic estimate separate. Optional responsive conversation requires its own usability review and opt-in. A cue may offer a neutral check-in such as “Would you like a break?” Proposed rules: two eligible distinct wearer turns, no active-task interruption, no quiet hours and at most one proactive check-in daily. These are product settings to evaluate, not clinical thresholds.

A decline suppresses repeat nudges. The person chooses among approved activities. Never trigger treatment, medication changes or external alerts solely from voice cues. Optional ElevenLabs speech uses approved facts and identifies the assistant; generated playback cannot feed memory capture or wearer emotion analysis.

## 5. Data and permissions

Extend the MVP identity/store rather than creating separate patient databases. Personal records carry household/person scope, row version, timestamps and purpose grants. Preserve immutable content versions in session history.

| Object | Essential fields |
|---|---|
| Support profile | Preferred name/language, accessibility, interests, avoidances, assistance and review |
| Care plan / goal | Chosen purpose, baseline, steps, restrictions, reviewer, status/version and review date |
| Activity / program | Module tags, locale, license/evidence, facilitator needs, prerequisites, approved version and deviations |
| Routine / session | Flexible window, helper requirement, exact plan/content versions, lifecycle and explicit completion report |
| Observation | Kind, value, reporter/source, observed time; model and policy versions for inference |
| Media | Private asset, contributor, permissions, caption/date, avoidances, review and expiry |
| Support task | Proposer, invited/accepted assignee, due window, state and completion report |
| Caregiver reflection | Individual owner, explicit sharing grants and retention; private by default |
| Sleep entry | Estimated intervals, unknown fields, subjective report and reporter type |
| Review / claims register | Evidence, audience, allowed wording, reviewer, version, decision and review date |

Observation kinds must distinguish self-report, caregiver report, task observation, acoustic estimate and delivery event. Models cannot create self-reports. Corrections append attributed records; deletion still removes personal content and derivatives as required.

Supporters receive person/category-specific grants. Household membership does not grant access to another caregiver's private reflections. Professional access is scoped and time-limited; content reviewers need no patient-data access. Administrative support access is explicit and audited.

## 6. Interfaces and AI limits

Reuse MVP authorization, durable jobs, events and scheduler. Add versioned APIs for profiles, goals, activity catalog, routines, sessions/actions, observations, media upload/review, support tasks, private reflections, sleep entries, content reviews and scoped exports. Require full schemas, idempotency, pagination and stale-version rejection.

Session actions are typed and validated against the current state. Media stays quarantined until validated and approved. Sharing includes a recipient/content preview. Event subscribers receive only authorized fields; revocation applies to pending jobs and subscriptions.

Content lifecycle: draft → reviewed → published → retired, with rejection/withdrawal paths. Approval applies to a specific version. New AI edits return to draft. Withdrawn content cannot start a new session; active sessions receive an appropriate stop/review response.

CREAO retains log/summary, patterns and reminder preparation. Additional tools may draft suggestions from approved content and preferences. Server permissions prevent agents from publishing clinical content, granting consent, changing restrictions, contacting people or marking completion. Treat retrieved text as untrusted. Missing suitable content yields no suggestion, not an invented intervention.

## 7. Reliability and privacy

Keep MVP consent/retention controls; add separate policies for media, reflections and professional plans. Basic memory aids remain usable with emotion disabled. Real-world consent, assent and representative involvement require an appropriate process; a caregiver click is not universal permission.

Use private encrypted media storage, decoded file validation, malware checks, size limits, unnecessary-location-metadata removal and short-lived authorized downloads. Deletion covers originals, derivatives, embeddings, caches and pending jobs.

Move SQLite to PostgreSQL before multi-instance production writes. Test migrations, backups and restore. Workers use leases/idempotency; caches include person/grant versions. Offline access includes only approved, unexpired cached material on protected devices. Reconcile observations by immutable IDs; do not replay stale instructions or automatic external actions.

Monitor delivery failure, queue age, stale content, access denial, acoustic abstention, costs and deletion completion without private payloads. Deployment-specific privacy, medical-product and hosting review precedes a real-world pilot.

## 8. Delivery and verification

| Stage | Scope | Completion evidence |
|---|---|---|
| 1 | Entire expanded MVP | All MVP acceptance cases, real-provider/device results and explicit blockers |
| 2 | Shared infrastructure and basic workflows for all nine modules | Working module journeys, approved content, permissions and accessible stop/pause |
| 3 | Specialist rehabilitation/CST/music programs and optional conversation | Licenses/protocols, professional workflow checks and target-user usability review |
| 4 | Consented pilot and outcome evaluation | Study-specific protocol, measured outcomes and reviewed claims |

Required full-product checks:

- Unreviewed goal/content changes never enter wearer sessions; withdrawals stop future use.
- Facilitated sessions record content/license versions, attendance and voluntary participation.
- Private reflections remain private across UI/API/export/events.
- Facts update correctly; memory/media stop and avoidance settings work across modules.
- Helper requirements, movement constraints and intake restrictions survive schedule changes.
- Music/app playback cannot become wearer speech or family facts.
- Quiet hours, DST, restart and offline recovery preserve pauses and expire old invitations.
- Delivery/timers never mark completion; multi-module sessions are not double-counted.
- Acoustic uncertainty cannot trigger confident labels or unsolicited alerts.
- Permission revocation, deletion and prompt-injection boundaries work end to end.

Evaluate task success, cue understanding, ability to stop, comfort, caregiver effort and adverse experiences with appropriately consented users. Acoustic evaluation reports attribution errors, abstention, per-label agreement and latency; staged demonstrations are not clinical validation. Keep self-reported outcomes separate from inferred signals.

Deliver implementation, migrations, synthetic examples, contracts, tests, reviewed-content import format, runbook and a requirements-to-tests checklist. Identify missing review, licenses, account access or hardware evidence precisely. Dashboard cards alone do not constitute completed modules.

## Evidence references

- E1: [NICE NG97 recommendations](https://www.nice.org.uk/guidance/ng97/chapter/Recommendations)
- E2: [Cochrane: cognitive rehabilitation, 2023](https://www.cochrane.org/evidence/CD013388_what-are-benefits-and-risks-cognitive-rehabilitation-people-mild-moderate-dementia)
- E3: [Cochrane: cognitive stimulation, 2023](https://www.cochrane.org/evidence/CD005562_can-cognitive-stimulation-benefit-people-dementia)
- E4: [START caregiver intervention: six-year follow-up](https://pubmed.ncbi.nlm.nih.gov/31298169/)
- E5: [Alzheimer's Association: repetition](https://www.alz.org/help-support/caregiving/stages-behaviors/repetition)
- E6: [Alzheimer's Association: daily care plans](https://www.alz.org/help-support/caregiving/daily-care/daily-care-plan)
- E7: [Cochrane: reminiscence, 2018](https://www.cochrane.org/evidence/CD001120_reminiscence-therapy-dementia)
- E8: [Cochrane: music-based interventions, 2025](https://www.cochrane.org/evidence/CD003477_does-music-based-therapy-help-people-dementia)
- E9: [NIA: living with early-stage dementia](https://www.nia.nih.gov/health/alzheimers-and-dementia/tips-living-alone-early-stage-dementia)
- E10: [NIA: healthy eating and Alzheimer's disease](https://www.nia.nih.gov/health/healthy-eating-nutrition-and-diet/healthy-eating-and-alzheimers-disease)
- E11: [Cochrane: sleep interventions, 2023](https://www.cochrane.org/evidence/CD011881_non-medicine-interventions-sleep-problems-dementia)
- E12: [NHS: sudden confusion](https://www.nhs.uk/symptoms/confusion/)

Use the companion MVP spec for provider references. Re-review evidence before changing treatment-related content or public claims.
