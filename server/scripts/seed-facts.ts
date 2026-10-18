// Posts sample caregiver facts, the way D's Creao side will.
// Usage: npm run seed-facts [server-url]
import 'dotenv/config'

const base = process.argv[2] ?? `http://localhost:${process.env.PORT ?? 8080}`
const facts = [
  { id: 'fact_mary', question: 'Where is Mary?', answer: 'Mary is at the store, back by 3.', answeredBy: 'Sarah', standing: false, remindAt: null },
  { id: 'fact_home', question: 'Where do I live?', answer: 'You live at 12 Oak Street with Sarah.', answeredBy: 'Sarah', standing: true, remindAt: null },
  { id: 'fact_visit', question: 'Who is visiting today?', answer: 'Your grandson Leo visits at 4.', answeredBy: 'Sarah', standing: false, remindAt: null },
]

const res = await fetch(`${base}/facts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.FACTS_SECRET ?? 'change-me-facts'}` },
  body: JSON.stringify({ v: 1, facts }),
})
console.log(res.status, await res.text())
