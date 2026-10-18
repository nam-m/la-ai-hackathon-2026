// Pretends to be A's phone app: connects, says hello, streams silent audio, prints what comes back.
// Usage: npm run fake-phone [ws-url]   (default ws://localhost:8080/ws)
import 'dotenv/config'
import WebSocket from 'ws'

const base = process.argv[2] ?? `ws://localhost:${process.env.PORT ?? 8080}/ws`
const ws = new WebSocket(`${base}?token=${process.env.APP_TOKEN ?? 'change-me-app'}`)
const started = Date.now()
const t = () => `${((Date.now() - started) / 1000).toFixed(1)}s`

ws.on('open', () => {
  console.log(`[${t()}] connected to ${base}`)
  ws.send(JSON.stringify({ v: 1, type: 'hello', session: 'fake-phone', source: 'glasses' }))
  // 100 ms frames at 16 kHz, 16-bit. Silence by default; FAKE_PHONE_NOISE=1 sends noise so the tone module has something to analyze.
  const noise = process.env.FAKE_PHONE_NOISE === '1'
  const makeFrame = () => {
    const f = Buffer.alloc(3200)
    if (noise) for (let i = 0; i < 1600; i++) f.writeInt16LE(Math.round((Math.random() * 2 - 1) * 3000), i * 2)
    return f
  }
  const audio = setInterval(() => ws.readyState === ws.OPEN && ws.send(makeFrame()), 100)
  const ping = setInterval(() => ws.send(JSON.stringify({ v: 1, type: 'ping' })), 15_000)
  ws.on('close', () => { clearInterval(audio); clearInterval(ping) })
})

ws.on('message', raw => {
  const msg = JSON.parse(raw.toString())
  if (msg.type === 'pong') return
  if (msg.type === 'answer') {
    const text = msg.text.replace(/[.!]+$/, '')
    const line = msg.speaker ? `${text}, ${msg.speaker}, ${msg.at}` : `${text} (told you at ${msg.at})`
    console.log(`[${t()}] GLASSES: ${line}`)
  } else {
    console.log(`[${t()}]`, msg)
  }
})

ws.on('close', (code, reason) => console.log(`[${t()}] closed ${code} ${reason}`))
ws.on('error', e => console.error('error', e.message))

const stopAfter = Number(process.env.FAKE_PHONE_SECONDS ?? 45)
setTimeout(() => { ws.close(); process.exit(0) }, stopAfter * 1000)
