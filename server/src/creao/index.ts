// Contract 5: Creao module. D owns this file and replaces the stubs.
// Nothing here is ever awaited in the live path.

export async function submitClip(wav: Buffer, range: { fromIso: string; toIso: string }): Promise<string> {
  console.log(`[creao stub] submitClip ${wav.length} bytes ${range.fromIso} to ${range.toIso}`)
  return `run_stub_${Date.now()}`
}

/**
 * Every 5 minutes: new transcript lines, Q&A pairs, question events and tone records.
 * The log, summary and patterns agents use transcript + tone together (spec v4 section 8).
 */
export async function submitLog(batch: {
  fromIso: string
  toIso: string
  transcript: unknown[]
  pairs: unknown[]
  events: unknown[]
  tones: unknown[]
}): Promise<string> {
  console.log(`[creao stub] submitLog ${batch.transcript.length} lines, ${batch.pairs.length} pairs, ${batch.events.length} questions, ${batch.tones.length} tones`)
  return `run_stub_${Date.now()}`
}

export async function runSummary(dateIso: string): Promise<string> {
  console.log(`[creao stub] runSummary ${dateIso}`)
  return `run_stub_${Date.now()}`
}

export async function runPatterns(dateIso: string): Promise<string> {
  console.log(`[creao stub] runPatterns ${dateIso}`)
  return `run_stub_${Date.now()}`
}

export async function handleWebhook(body: unknown): Promise<void> {
  console.log('[creao stub] webhook', JSON.stringify(body).slice(0, 200))
}
