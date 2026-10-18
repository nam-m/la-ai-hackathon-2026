import { AudioInputSource, type AudioEvent, type EvenAppBridge } from '@evenrealities/even_hub_sdk'

// The G2 streams ~100 ms chunks the whole time capture is on, even in a silent
// room. A gap this long means capture stopped under us (WebView suspended, BLE
// hiccup), so the watchdog re-arms it.
const STALL_MS = 3_000

export type MicState = 'off' | 'starting' | 'live' | 'denied'

type Handlers = {
  onChunk(event: AudioEvent): void
  onState(state: MicState): void
}

/** Glasses mic capture that keeps itself running while it is wanted. */
export class Mic {
  state: MicState = 'off'
  private wanted = false
  private arming = false
  private lastChunkAt = 0
  private watchdog: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly bridge: EvenAppBridge,
    private readonly handlers: Handlers,
  ) {}

  /** Starts capture unless audio is already flowing. Idempotent: call it on every resume signal. */
  async ensureOn() {
    this.wanted = true
    this.watchdog ??= setInterval(() => this.checkStall(), 1_000)
    if (this.state === 'live' && !this.stalled()) return
    await this.arm()
  }

  async off() {
    this.wanted = false
    clearInterval(this.watchdog)
    this.watchdog = undefined
    this.setState('off')
    await this.bridge.audioControl(false)
  }

  /** Feed every `audioEvent` from the bridge here. */
  handleChunk(event: AudioEvent) {
    this.lastChunkAt = Date.now()
    // Stragglers can arrive just after off(); pause means nothing leaves the phone.
    if (!this.wanted) return
    this.setState('live')
    this.handlers.onChunk(event)
  }

  private stalled(): boolean {
    return Date.now() - this.lastChunkAt > STALL_MS
  }

  private checkStall() {
    // A denied mic stays denied until the wearer taps to retry, so the
    // permission prompt isn't fired every few seconds.
    if (!this.wanted || this.state === 'denied' || !this.stalled()) return
    console.warn('[mic] no audio for', STALL_MS, 'ms, re-arming')
    void this.arm()
  }

  private async arm() {
    if (this.arming) return
    this.arming = true
    this.setState('starting')
    try {
      // The glasses mic only opens once the startup page exists; main.ts creates it first.
      const ok = await this.bridge.audioControl(true, AudioInputSource.Glasses)
      if (!this.wanted) return
      if (ok) this.lastChunkAt = Date.now() // give the first chunk a full STALL_MS to arrive
      else this.setState('denied')
    } catch (err) {
      console.error('[mic] audioControl failed', err)
      if (this.wanted) this.setState('denied')
    } finally {
      this.arming = false
    }
  }

  private setState(state: MicState) {
    if (state === this.state) return
    this.state = state
    this.handlers.onState(state)
  }
}
