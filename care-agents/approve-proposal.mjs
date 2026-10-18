#!/usr/bin/env node
// Beat 5 bridge: a human approves a Care assistant proposal, then it is posted to the server's POST /facts.
// The agent only proposes. Nothing reaches the glasses until a person types APPROVE here.
//
//   FACTS_SECRET=... SERVER_URL=https://<server> node care-agents/approve-proposal.mjs proposal.json [--id fact_visit] [--by Sarah] [--dry-run]
//
// proposal.json is the Care assistant's JSON output (the whole object, or just its "proposal" part).
// --id    server fact id to replace (default: the proposal's replaces_fact_id)
// --by    who the family member is (default: Sarah), stored as answeredBy
// --dry-run  show what would be posted and exit
import { readFileSync } from 'node:fs'
import readline from 'node:readline/promises'

const args = process.argv.slice(2)
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
const file = args.find((a, i) => !a.startsWith('--') && !(i > 0 && ['--id', '--by'].includes(args[i - 1])))
const dryRun = args.includes('--dry-run')
const fail = (m) => { console.error(`Not posted: ${m}`); process.exit(1) }

if (!file) fail('usage: approve-proposal.mjs proposal.json [--id FACT_ID] [--by NAME] [--dry-run]')
let doc
try { doc = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { fail(`cannot read ${file}: ${e.message}`) }

const proposal = doc.proposal ?? (doc.action ? doc : null)
if (doc.rejected_reason) fail(`the agent refused this request: ${doc.rejected_reason}`)
if (doc.clarifying_question) fail(`the agent needs an answer first: ${doc.clarifying_question}`)
if (doc.role && doc.role !== 'caregiver') fail(`role is ${doc.role}; only caregiver proposals change facts`)
if (!proposal || proposal.action !== 'replace_fact') fail('no replace_fact proposal in this file')
if (!proposal.answer_wording?.trim()) fail('proposal has no answer_wording')
if (!proposal.question?.trim()) fail('proposal has no question')
if (!proposal.valid_until || Number.isNaN(Date.parse(proposal.valid_until))) fail('proposal needs a valid valid_until time')
if (Date.parse(proposal.valid_until) <= Date.now()) fail(`valid_until ${proposal.valid_until} is already in the past, so the glasses would never show it`)

const id = flag('--id') ?? proposal.replaces_fact_id
if (!id) fail('no fact id: pass --id')
const fact = {
  id, question: proposal.question, answer: proposal.answer_wording, answeredBy: flag('--by') ?? 'Sarah',
  standing: false, remindAt: null, expiresAt: proposal.valid_until,
}
const base = (process.env.SERVER_URL ?? 'http://localhost:8080').replace(/\/$/, '')

console.log('\nThe glasses will tell the patient, word for word:')
console.log(`  "${fact.answer}"`)
console.log(`Question it answers : ${fact.question}`)
console.log(`Replaces fact id    : ${fact.id}`)
console.log(`Shown until         : ${fact.expiresAt}`)
console.log(`Server              : ${base}\n`)
if (dryRun) { console.log('Dry run, nothing posted.\n', JSON.stringify({ v: 1, facts: [fact] }, null, 2)); process.exit(0) }

const secret = process.env.FACTS_SECRET
if (!secret) fail('set FACTS_SECRET (the same secret the server uses); it is not stored in this repo')
if (!process.stdin.isTTY) fail('approval must be typed by a person at a terminal')

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const answer = (await rl.question('Type APPROVE to publish this to the glasses, anything else cancels: ')).trim()
rl.close()
if (answer !== 'APPROVE') fail('cancelled, nothing posted')

const res = await fetch(`${base}/facts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
  body: JSON.stringify({ v: 1, facts: [fact] }),
})
const text = await res.text()
if (!res.ok) fail(`server said ${res.status} ${text}`)
console.log(`Published (${res.status} ${text}). Ask the glasses "${fact.question}" to check.`)
