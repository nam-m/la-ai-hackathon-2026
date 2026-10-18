// Pretends to be the glasses app (Part A's stub for C): connects to /ws, sends
// hello and pings like the real app, streams a 16 kHz mono 16-bit WAV in
// 100 ms frames at real-time pace, and prints whatever the server sends back.
// Feed it recordings made with the phone's debug panel to test with real G2 audio;
// --meta replays the glasses' speakerRole from the recording's .json as the app would.
//
//   npm run fake-phone -- --wav dev/recordings/g2-....wav [--meta dev/recordings/g2-....json]
//                         [--url ws://localhost:8787/ws] [--token dev] [--loop]
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import WebSocket from 'ws'

// What the G2 sends per audio event: 100 ms of s16le at 16 kHz.
const FRAME_BYTES = 3_200
const FRAME_MS = 100
const PING_EVERY_MS = 15_000
const LINGER_MS = 10_000

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'ws://localhost:8787/ws' },
    wav: { type: 'string' },
    meta: { type: 'string' },
    token: { type: 'string', default: 'dev' },
    session: { type: 'string', default: 'demo-1' },
    loop: { type: 'boolean', default: false },
  },
})
if (!args.wav) {
  console.error('usage: npm run fake-phone -- --wav <file.wav> [--meta <file.json>] [--url ws://host/ws] [--token dev] [--loop]')
  process.exit(1)
}

const pcm = readPcm(await readFile(args.wav))
// The speakerRole of each 100 ms frame, from the debug panel's recording.
const roles: string[] = args.meta ? JSON.parse(await readFile(args.meta, 'utf8')).frames.map((f: { role: string }) => f.role) : []
console.log(`streaming ${(pcm.length / 32_000).toFixed(1)} s of audio to ${args.url}`)

const url = new URL(args.url)
url.searchParams.set('token', args.token)
const ws = new WebSocket(url)

ws.on('open', () => {
  ws.send(JSON.stringify({ v: 1, type: 'hello', session: args.session, source: 'glasses' }))
  const ping = setInterval(() => ws.send(JSON.stringify({ v: 1, type: 'ping' })), PING_EVERY_MS)
  let offset = 0
  let sentRole: string | undefined
  const stream = setInterval(() => {
    if (offset >= pcm.length) {
      if (args.loop) {
        offset = 0
      } else {
        clearInterval(stream)
        console.log(`done streaming; waiting ${LINGER_MS / 1000} s for answers`)
        setTimeout(() => {
          clearInterval(ping)
          ws.close()
        }, LINGER_MS)
        return
      }
    }
    // Like the app: the role goes ahead of the audio it belongs to, only when it changes.
    const role = roles[offset / FRAME_BYTES]
    if (role && role !== sentRole) {
      ws.send(JSON.stringify({ v: 1, type: 'role', role }))
      sentRole = role
    }
    ws.send(pcm.subarray(offset, offset + FRAME_BYTES))
    offset += FRAME_BYTES
  }, FRAME_MS)
})
ws.on('message', (data, isBinary) => {
  if (!isBinary) console.log(`[server] ${data.toString()}`)
})
ws.on('close', code => {
  console.log(`closed (${code})`)
  process.exit(0)
})
ws.on('error', err => {
  console.error(`socket error: ${err.message}`)
  process.exit(1)
})

/** Returns the PCM samples of a 16 kHz mono 16-bit WAV, or exits explaining how to convert it. */
function readPcm(file: Buffer): Buffer {
  if (file.toString('ascii', 0, 4) !== 'RIFF' || file.toString('ascii', 8, 12) !== 'WAVE') fail('not a WAV file')
  let format: { codec: number; channels: number; rate: number; bits: number } | null = null
  let offset = 12
  while (offset + 8 <= file.length) {
    const id = file.toString('ascii', offset, offset + 4)
    const size = file.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      format = {
        codec: file.readUInt16LE(body),
        channels: file.readUInt16LE(body + 2),
        rate: file.readUInt32LE(body + 4),
        bits: file.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      if (!format || format.codec !== 1 || format.channels !== 1 || format.rate !== 16_000 || format.bits !== 16) {
        fail(`need PCM 16 kHz mono 16-bit, got ${JSON.stringify(format)}`)
      }
      return file.subarray(body, body + size)
    }
    offset = body + size + (size & 1) // chunks are word-aligned
  }
  fail('no data chunk')
}

function fail(reason: string): never {
  console.error(`${args.wav}: ${reason}`)
  console.error('convert with: ffmpeg -i in.wav -ac 1 -ar 16000 -sample_fmt s16 out.wav')
  process.exit(1)
}
