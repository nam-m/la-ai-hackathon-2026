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

function verifyProvider(): 'gemini' | 'stepfun' | 'claude' {
  const v = env('VERIFY_PROVIDER', 'gemini').trim().toLowerCase()
  if (v === 'gemini' || v === 'stepfun' || v === 'claude') return v
  console.warn(`[config] VERIFY_PROVIDER=${process.env.VERIFY_PROVIDER} is not gemini, stepfun or claude; using gemini`)
  return 'gemini'
}

/** Who says which utterances are the wearer's: the glasses' speakerRole tags (sent by the phone) or calibrated loudness. */
function speechRoleSource(): 'glasses' | 'loudness' {
  const v = env('SPEECH_ROLE_SOURCE', 'glasses').trim().toLowerCase()
  if (v === 'glasses' || v === 'loudness') return v
  console.warn(`[config] SPEECH_ROLE_SOURCE=${process.env.SPEECH_ROLE_SOURCE} is not glasses or loudness; using glasses`)
  return 'glasses'
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
  // glasses: the phone's role tags decide when it sends them, loudness otherwise.
  speechRoleSource: speechRoleSource(),
  geminiApiKey: env('GEMINI_API_KEY'),
  embedModel: env('EMBED_MODEL', 'gemini-embedding-001'),
  verifyModel: env('VERIFY_MODEL', 'gemini-2.5-flash'),
  // Who answers the yes/no checks. Embeddings always use Gemini (StepFun has no embeddings API).
  verifyProvider: verifyProvider(),
  stepfunApiKey: env('STEPFUN_API_KEY'),
  stepfunBaseUrl: env('STEPFUN_BASE_URL', 'https://api.stepfun.ai/v1'), // international; api.stepfun.com for China-region keys
  stepfunModel: env('STEPFUN_MODEL'), // pick a fast chat model from platform.stepfun.com
  // Claude matcher: without GEMINI_API_KEY it picks repeats itself (it has no embeddings API) and answers the yes/no checks.
  anthropicApiKey: env('ANTHROPIC_API_KEY'),
  claudeModel: env('CLAUDE_MODEL', 'claude-haiku-5-5'),
  matchThreshold: Number(env('MATCH_THRESHOLD', '0.80')),
  dataFile: env('DATA_FILE', './data/store.json'),
  toneUrl: env('TONE_URL'), // empty = tone analysis off
  toneSecret: env('TONE_SECRET', 'change-me-tone'),
  // Reverse geocoding for "Where am I?" (OpenStreetMap; free, one request per second).
  nominatimUrl: env('NOMINATIM_URL', 'https://nominatim.openstreetmap.org'),
  voiceUrl: env('VOICE_URL'), // voice-service/; empty = voice recognition off
  voiceSecret: env('VOICE_SECRET'),
  voiceThreshold: Number(env('VOICE_THRESHOLD', '0.47')), // fused cosine; the prototype's benchmark optimum
  // Server-driven Creao runs, wearer's local time, HH:MM.
  summaryAt: hhmm('SUMMARY_AT', '20:00'),
  patternsAt: hhmm('PATTERNS_AT', '23:30'),
  // Open Questions runs by itself this often (minutes), only when new questions came in since the last run. 0 = off.
  openQuestionsEveryMin: Math.max(0, Number(env('OPEN_QUESTIONS_EVERY_MIN', '30')) || 0),
  // A demo day (src/demo.ts) on the glasses and the dashboard, under real data.
  demoData: env('DEMO_DATA') === '1',
  // /debug/* routes; off when NODE_ENV=production (the Dockerfile sets it).
  debugRoutes: env('NODE_ENV') !== 'production',
}

/** What finds repeats: Gemini embeddings, else Claude, else the offline word-overlap fallback. */
export const matcherName = config.geminiApiKey ? 'gemini' : config.anthropicApiKey ? 'claude' : 'local'
/** What answers the yes/no checks. */
export const verifierName = config.geminiApiKey ? config.verifyProvider : config.anthropicApiKey ? 'claude' : 'local'

/** D: pass this as webhook_url when starting Creao runs. Creao can't send our Bearer header, so the secret rides here. */
export const webhookUrl = () => `${config.publicUrl}/creao/webhook?s=${encodeURIComponent(config.webhookSecret)}`
