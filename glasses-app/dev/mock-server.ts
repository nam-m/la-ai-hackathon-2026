// Stand-in for C's server that speaks Contract 1 (Build Guide.md), so the
// glasses app can be built and tested before the real server exists.
//
//   npm run mock        listens on ws://localhost:8787/ws (MOCK_PORT to change)
//
// Type a letter + Enter: a = send an answer now, c = clear, e = stt_down error.
import { createInterface } from 'node:readline'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import type { Answer, ClientMessage, ServerMessage } from '../src/protocol'

const PORT = Number(process.env.MOCK_PORT ?? 8787)
const ANSWER_EVERY_MS = 20_000
const RATE_LOG_MS = 5_000

// Cycles through the display cases: a named speaker, no speaker (the
// ElevenLabs path), a family fact, and one too long for two lines ("See phone").
const SAMPLES: Array<Pick<Answer, 'text' | 'speaker' | 'source'>> = [
  { text: 'Lunch is at noon.', speaker: 'Sarah', source: 'spoken' },
  { text: 'Your glasses case is on the kitchen table.', speaker: null, source: 'spoken' },
  { text: 'Mary is at the store, back by 3.', speaker: 'Sarah', source: 'family' },
  {
    text: 'David is driving over after work and should be here around six thirty, and he is bringing the photo albums you asked about.',
    speaker: 'David',
    source: 'spoken',
  },
]

type Client = { id: number; ws: WebSocket; paused: boolean; bytes: number; pausedBytes: number }

const clients = new Set<Client>()
let nextClientId = 1
let sampleIndex = 0

const wss = new WebSocketServer({ port: PORT, path: '/ws' })
wss.on('listening', () => console.log(`mock server on ws://localhost:${PORT}/ws`))

wss.on('connection', (ws, req) => {
  const client: Client = { id: nextClientId++, ws, paused: false, bytes: 0, pausedBytes: 0 }
  const token = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token')
  if (!token) {
    send(client, { v: 1, type: 'error', code: 'unauthorized', message: 'Missing token' })
    ws.close()
    return
  }
  clients.add(client)
  log(client, `connected from ${req.socket.remoteAddress}`)
  ws.on('message', (data, isBinary) => (isBinary ? onAudio(client, data) : onText(client, data.toString())))
  ws.on('close', () => {
    clients.delete(client)
    log(client, 'disconnected')
  })
})

function onAudio(client: Client, data: RawData) {
  const size = Array.isArray(data) ? data.reduce((n, b) => n + b.length, 0) : data.byteLength
  if (client.paused) client.pausedBytes += size
  else client.bytes += size
}

function onText(client: Client, raw: string) {
  let msg: ClientMessage
  try {
    msg = JSON.parse(raw)
  } catch {
    log(client, `bad JSON: ${raw}`)
    return
  }
  switch (msg.type) {
    case 'hello':
      log(client, `hello session=${msg.session} source=${msg.source}`)
      send(client, { v: 1, type: 'status', text: 'Listening' })
      return
    case 'ping':
      send(client, { v: 1, type: 'pong' })
      return
    case 'role':
      // The glasses' speakerRole for the audio that follows; the mock has no speech to label.
      return
    case 'control':
      client.paused = msg.action === 'pause'
      log(client, msg.action)
      send(client, { v: 1, type: 'status', text: client.paused ? 'Paused' : 'Listening' })
      return
    default:
      log(client, `unknown message: ${raw}`)
  }
}

setInterval(() => {
  for (const client of clients) {
    const rate = client.bytes / 1024 / (RATE_LOG_MS / 1000)
    // The real G2 sends 16 kHz s16le mono: about 31 kB/s.
    log(client, `audio ${rate.toFixed(1)} kB/s${client.paused ? ' (paused)' : ''}`)
    if (client.pausedBytes > 0) log(client, `WARNING: ${client.pausedBytes} bytes of audio arrived while paused`)
    client.bytes = 0
    client.pausedBytes = 0
  }
}, RATE_LOG_MS)

setInterval(sendAnswer, ANSWER_EVERY_MS)

function sendAnswer() {
  const sample = SAMPLES[sampleIndex++ % SAMPLES.length]
  // en-US time with a plain space (newer ICU puts U+202F before AM/PM).
  const at = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ')
  const answer: Answer = { v: 1, type: 'answer', id: `qa_${sampleIndex}`, at, ...sample }
  for (const client of clients) {
    if (client.paused) continue
    send(client, answer)
    log(client, `sent answer: ${answer.text}`)
  }
}

function broadcast(msg: ServerMessage) {
  for (const client of clients) send(client, msg)
}

function send(client: Client, msg: ServerMessage) {
  client.ws.send(JSON.stringify(msg))
}

function log(client: Client, text: string) {
  console.log(`${new Date().toLocaleTimeString()} [phone ${client.id}] ${text}`)
}

createInterface({ input: process.stdin }).on('line', line => {
  const key = line.trim()
  if (key === 'a') sendAnswer()
  else if (key === 'c') broadcast({ v: 1, type: 'clear' })
  else if (key === 'e') broadcast({ v: 1, type: 'error', code: 'stt_down', message: 'Transcription unavailable' })
  else if (key) console.log('keys: a = answer now, c = clear, e = stt_down error')
})
