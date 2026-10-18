// Tunes the matcher. Stores each "stored" question, then asks the "asked" one.
// Goal: zero wrong matches first, then as many right matches as possible.
// Usage: npm run test:matcher            (uses GEMINI_API_KEY if set, else local fallback)
//        MATCH_THRESHOLD=0.85 npm run test:matcher
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-')), 'store.json')
const store = await import('../src/store.js')
const { findMatch, warm } = await import('../src/matcher.js')

// [stored question, asked question]
const shouldMatch: [string, string][] = [
  ["When's lunch?", 'What time do we eat?'],
  ['What time is lunch?', 'Is it lunchtime yet?'],
  ['Where is Mary?', 'Where did my wife go?'],
  ['Where is Mary?', "Where's Mary gone?"],
  ['Who is visiting today?', 'Is anyone coming over today?'],
  ['What day is it?', 'What day of the week is it today?'],
  ['Did I take my pills?', 'Have I taken my medicine yet?'],
  ['When is my doctor appointment?', 'What time do I see the doctor?'],
  ['Where are my glasses?', 'Have you seen my glasses?'],
  ['What are we having for dinner?', "What's for supper?"],
  ['Is Sarah coming home tonight?', 'Will Sarah be back this evening?'],
  ['Where do I live?', "What's my address?"],
  ['When is Leo coming?', 'What time will Leo get here?'],
  ['Did the dog get fed?', 'Has someone fed the dog?'],
  ['What month is it?', 'Which month are we in?'],
  ['Where are we going today?', 'Are we going somewhere today?'],
  ['When does the mail come?', 'What time is the mail delivered?'],
  ['Is it going to rain?', 'Will it rain today?'],
  ["Where's my purse?", 'Have you seen my handbag?'],
  ['When is church?', 'What time do we leave for church?'],
]
const shouldNotMatch: [string, string][] = [
  ["When's lunch?", "Where's lunch?"],
  ['Where is Mary?', 'When is Mary coming back?'],
  ['Who is visiting today?', 'Who visited yesterday?'],
  ['Did I take my pills?', 'Where are my pills?'],
  ['What time is dinner?', 'What are we having for dinner?'],
  ['Where are my glasses?', 'Are these my glasses?'],
  ['Is Sarah coming home tonight?', 'Is Mary coming home tonight?'],
  ['When is my doctor appointment?', "What is my doctor's name?"],
  ['What day is it?', 'What time is it?'],
  ['Did the dog get fed?', 'Did the cat get fed?'],
]

let truePos = 0, falseNeg = 0, falsePos = 0, trueNeg = 0
const run = async (pairs: [string, string][], expect: boolean) => {
  for (const [stored, asked] of pairs) {
    for (const r of store.allRecords()) store.remove(r.id)
    const now = new Date().toISOString()
    const record = { id: 'test', question: stored, answer: 'ANSWER', askedAt: now, answeredAt: now, answeredBy: 'Sarah', source: 'spoken' as const, standing: false }
    store.upsert(record)
    await warm(record) // live path only uses cached embeddings
    const { match, log } = await findMatch(asked)
    const got = Boolean(match)
    if (expect && got) truePos++
    if (expect && !got) falseNeg++
    if (!expect && got) falsePos++
    if (!expect && !got) trueNeg++
    const mark = got === expect ? 'ok  ' : expect ? 'MISS' : 'WRONG'
    console.log(`${mark} score=${log.best?.score ?? '-'}  "${stored}"  vs  "${asked}"  (${log.decision}, ${log.ms} ms)`)
  }
}

console.log(`matcher: ${process.env.GEMINI_API_KEY ? 'gemini' : 'local fallback'}\n`)
await run(shouldMatch, true)
console.log()
await run(shouldNotMatch, false)
console.log(`\ncaught repeats: ${truePos}/${shouldMatch.length}   wrong matches: ${falsePos}/${shouldNotMatch.length}  (must be 0)`)
process.exit(0)
