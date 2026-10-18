import { APP_TOKEN, SERVER_URL, SESSION } from './config'
import { parseServerMessage, type ClientMessage, type ServerMessage } from './protocol'

const PING_EVERY_MS = 15_000
// A socket can sit in OPEN long after the network under it died (phone asleep,
// Wi-Fi switch). Two ping periods without hearing anything means dead.
const STALE_AFTER_MS = 2 * PING_EVERY_MS
// Contract 1 backoff: 1, 2, 4, then 10 s.
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 10_000]

export type SocketState = 'connecting' | 'open' | 'closed'

type Handlers = {
  onMessage(msg: ServerMessage): void
  onState(state: SocketState): void
}

/** The phone's one connection to the team server; reconnects on its own. */
export class ServerSocket {
  private ws: WebSocket | null = null
  private attempt = 0
  private lastHeard = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private stopped = true
  /** Audio bytes sent so far, for the phone's rate readout. */
  bytesSent = 0

  constructor(private readonly handlers: Handlers) {}

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  start() {
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    clearTimeout(this.retryTimer)
    this.drop()
  }

  send(msg: ClientMessage) {
    if (this.isOpen) this.ws!.send(JSON.stringify(msg))
  }

  /** Sends one PCM chunk. Dropped while disconnected: late live audio is useless. */
  sendAudio(pcm: Uint8Array) {
    if (!this.isOpen) return
    this.ws!.send(pcm)
    this.bytesSent += pcm.byteLength
  }

  /** On resume: keeps a healthy socket, replaces a dead one now instead of after the backoff. */
  ensureConnected() {
    if (this.stopped) return
    const state = this.ws?.readyState
    if (state === WebSocket.CONNECTING) return
    if (state === WebSocket.OPEN && Date.now() - this.lastHeard < STALE_AFTER_MS) return
    this.attempt = 0
    this.connect()
  }

  private connect() {
    clearTimeout(this.retryTimer)
    this.drop()
    let ws: WebSocket
    try {
      const url = new URL(SERVER_URL)
      url.searchParams.set('token', APP_TOKEN)
      ws = new WebSocket(url)
    } catch (err) {
      console.error('[socket] cannot open', SERVER_URL, err)
      this.scheduleRetry()
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.handlers.onState('connecting')

    ws.onopen = () => {
      this.attempt = 0
      this.lastHeard = Date.now()
      // Contract 1: hello first after every connect.
      this.send({ v: 1, type: 'hello', session: SESSION, source: 'glasses' })
      this.pingTimer = setInterval(() => this.ping(), PING_EVERY_MS)
      this.handlers.onState('open')
    }
    ws.onmessage = event => {
      this.lastHeard = Date.now()
      if (typeof event.data !== 'string') return
      const msg = parseServerMessage(event.data)
      if (msg) this.handlers.onMessage(msg)
      else console.warn('[socket] ignoring message', event.data)
    }
    // onerror is always followed by onclose, so the retry lives there.
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.drop()
      this.scheduleRetry()
    }
  }

  private ping() {
    if (Date.now() - this.lastHeard > STALE_AFTER_MS) {
      console.warn('[socket] server silent, reconnecting')
      this.drop()
      this.scheduleRetry()
      return
    }
    this.send({ v: 1, type: 'ping' })
  }

  // Detaches and closes the current socket so its own onclose can't schedule a second retry.
  private drop() {
    clearInterval(this.pingTimer)
    const ws = this.ws
    if (!ws) return
    this.ws = null
    ws.onopen = null
    ws.onmessage = null
    ws.onclose = null
    if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close()
    this.handlers.onState('closed')
  }

  private scheduleRetry() {
    if (this.stopped) return
    const delay = RETRY_DELAYS_MS[Math.min(this.attempt, RETRY_DELAYS_MS.length - 1)]
    this.attempt++
    this.retryTimer = setTimeout(() => this.connect(), delay)
  }
}
