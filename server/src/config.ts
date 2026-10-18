import 'dotenv/config'
import { speechOptionsFromEnv } from './speech/config.js'

// An empty value counts as unset, so `MATCH_THRESHOLD=` in .env doesn't silently become 0.
const env = (name: string, fallback = '') => process.env[name] || fallback
const speechOptions = speechOptionsFromEnv({ ...process.env, SPEECH_PROVIDER: env('SPEECH_PROVIDER', 'fake') })

/** HH:MM, zero-padded so times compare correctly ("8:00" -> "08:00"); warns and uses the fallback if invalid. */
function hhmm(name: string, fallback: string) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(env(name, fallback).trim())
  if (m && Number(m[1]) < 24 && Number(m[2]) < 60) return `${m[1].padStart(2, '0')}:${m[2]}`
  console.warn(`[config] ${name}=${process.env[name]} is not HH:MM; using ${fallback}`)
  return fallback
}

function verifyProvider(): 'gemini' | 'stepfun' {
  const v = env('VERIFY_PROVIDER', 'gemini').trim().toLowerCase()
  if (v === 'gemini' || v === 'stepfun') return v
  console.warn(`[config] VERIFY_PROVIDER=${process.env.VERIFY_PROVIDER} is not gemini or stepfun; using gemini`)
  return 'gemini'
}

export const config = {
  port: Number(env('PORT', '8080')),
  appToken: env('APP_TOKEN', 'change-me-app'),
  factsSecret: env('FACTS_SECRET', 'change-me-facts'),
  webhookSecret: env('WEBHOOK_SECRET', 'change-me-webhook'), // rides in the Creao webhook URL; separate from FACTS_SECRET
  publicUrl: env('PUBLIC_URL', 'http://localhost:8080'),
  timezone: env('TIMEZONE', 'America/Los_Angeles'),
  speechProvider: speechOptions.provider,
  speechApiKey: speechOptions.apiKey,
  speechOptions,
  geminiApiKey: env('GEMINI_API_KEY'),
  embedModel: env('EMBED_MODEL', 'gemini-embedding-001'),
  verifyModel: env('VERIFY_MODEL', 'gemini-2.5-flash'),
  // Who answers the yes/no checks. Embeddings always use Gemini (StepFun has no embeddings API).
  verifyProvider: verifyProvider(),
  stepfunApiKey: env('STEPFUN_API_KEY'),
  stepfunBaseUrl: env('STEPFUN_BASE_URL', 'https://api.stepfun.ai/v1'), // international; api.stepfun.com for China-region keys
  stepfunModel: env('STEPFUN_MODEL'), // pick a fast chat model from platform.stepfun.com
  matchThreshold: Number(env('MATCH_THRESHOLD', '0.80')),
  dataFile: env('DATA_FILE', './data/store.json'),
  toneUrl: env('TONE_URL'), // empty = tone analysis off
  toneSecret: env('TONE_SECRET', 'change-me-tone'),
  // Server-driven Creao runs, wearer's local time, HH:MM.
  summaryAt: hhmm('SUMMARY_AT', '20:00'),
  patternsAt: hhmm('PATTERNS_AT', '23:30'),
  // /debug/* routes; off when NODE_ENV=production (the Dockerfile sets it).
  debugRoutes: env('NODE_ENV') !== 'production',
}

/** D: pass this as webhook_url when starting Creao runs. Creao can't send our Bearer header, so the secret rides here. */
export const webhookUrl = () => `${config.publicUrl}/creao/webhook?s=${encodeURIComponent(config.webhookSecret)}`
