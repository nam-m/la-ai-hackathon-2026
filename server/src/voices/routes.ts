// Voice dashboard (PC debug view): GET /voices is the page; its data and actions need FACTS_SECRET.
import fs from 'node:fs'
import { Router, type RequestHandler } from 'express'
import { config } from '../config.js'
import * as store from '../store.js'
import { voiceStatus } from './client.js'
import { VOICE, label } from './gallery.js'
import { gallery, trackers, voiceEvents } from './tracker.js'

const PAGE = new URL('./dashboard.html', import.meta.url)

export function voiceRoutes(requireSecret: RequestHandler) {
  const r = Router()

  // Read on every request so edits show without a restart; it's a debug page.
  r.get('/voices', (_req, res) => res.type('html').send(fs.readFileSync(PAGE, 'utf8')))

  r.get('/voices/state', requireSecret, (_req, res) => {
    const g = gallery()
    const labelOf = (id?: string) => { const v = id ? g.get(id) : undefined; return v ? label(v) : null }
    res.json({
      service: voiceStatus(),
      names: config.anthropicApiKey ? `claude (${config.claudeModel})` : 'patterns only (no ANTHROPIC_API_KEY)',
      threshold: g.threshold,
      rules: VOICE,
      wearerSamples: g.wearerSamples,
      sessions: [...trackers].map(t => t.snapshot()),
      voices: g.list()
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
        .map(v => ({ id: v.id, label: label(v), name: v.name, saved: Boolean(v.name), samples: v.samples.length, createdAt: v.createdAt, lastSeenAt: v.lastSeenAt, heard: v.heard, evidence: v.evidence ?? null })),
      events: voiceEvents().slice(-150).reverse(),
      transcript: store.todaysTranscript().slice(-40).reverse().map(l => ({ ...l, voice: labelOf(l.voiceId) })),
    })
  })

  r.post('/voices/settings', requireSecret, (req, res) => {
    const t = Number(req.body?.threshold)
    if (!Number.isFinite(t) || t < 0.2 || t > 0.9) return void res.status(400).json({ error: 'threshold must be 0.2 to 0.9' })
    gallery().threshold = t
    console.log(`[voice] threshold=${t}`)
    res.json({ threshold: t })
  })

  r.post('/voices/:id/name', requireSecret, (req, res) => {
    const result = gallery().assignName(req.params.id, String(req.body?.name ?? ''), {
      text: '(typed on the voice dashboard)', kind: 'manual', confidence: 1, by: 'dashboard', at: new Date().toISOString(),
    })
    if (!result.ok) return void res.status(400).json({ error: result.reason })
    console.log(`[voice] ${req.params.id} named ${result.voice.name} on the dashboard`)
    res.json({ voice: { id: result.voice.id, name: result.voice.name, merged: result.merged } })
  })

  r.delete('/voices/:id', requireSecret, (req, res) => {
    const removed = gallery().remove(req.params.id)
    if (removed) console.log(`[voice] ${req.params.id} deleted on the dashboard`)
    res.json({ removed })
  })

  r.post('/voices/forget-wearer', requireSecret, (_req, res) => {
    gallery().forgetWearer()
    res.json({ ok: true })
  })

  return r
}
