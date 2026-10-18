import { AppLocationAccuracy, type AppLocation, type EvenAppBridge } from '@evenrealities/even_hub_sdk'

// Where the phone is, for "Where am I?" (the server turns it into an address).
// The Even app's own location API needs the `location` permission in app.json;
// it gives null on a timeout, a denied permission or bad coordinates. The
// simulator has no location at all, so dev can use VITE_FAKE_LOCATION="lat,lon".

export type Fix = { latitude: number; longitude: number; accuracy: number | null; at: string }

const UPDATE_EVERY_MS = 30_000
const MOVED_METERS = 25 // updates closer than this to the last fix are not news
const POLL_EVERY_MS = 60_000 // when the host can't push updates

function fakeFix(): Fix | null {
  const [lat, lon] = String(import.meta.env.VITE_FAKE_LOCATION ?? '').split(',').map(Number)
  return Number.isFinite(lat) && Number.isFinite(lon) && (lat || lon) ? { latitude: lat, longitude: lon, accuracy: 10, at: new Date().toISOString() } : null
}

function toFix(loc: AppLocation | null | undefined): Fix | null {
  if (!loc || !Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) return null
  if (Math.abs(loc.latitude) > 90 || Math.abs(loc.longitude) > 180 || (loc.latitude === 0 && loc.longitude === 0)) return null
  return {
    latitude: loc.latitude,
    longitude: loc.longitude,
    accuracy: Number.isFinite(loc.accuracy) ? Math.round(loc.accuracy!) : null,
    at: new Date(loc.timestamp && loc.timestamp > 1e12 ? loc.timestamp : Date.now()).toISOString(),
  }
}

export class Locator {
  last: Fix | null = null
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private unsubscribe: (() => void) | undefined

  constructor(
    private readonly bridge: EvenAppBridge,
    private readonly onFix: (fix: Fix, source: 'gps' | 'fake') => void,
  ) {}

  async start() {
    const first = await this.once()
    if (first) this.emit(first, 'gps')
    try {
      this.unsubscribe = this.bridge.onAppLocationChanged(loc => {
        const fix = toFix(loc)
        if (fix) this.emit(fix, 'gps')
      })
      const started = await this.bridge.startAppLocationUpdates({ accuracy: AppLocationAccuracy.Medium, intervalMs: UPDATE_EVERY_MS, distanceFilter: MOVED_METERS })
      if (!started) throw new Error('location updates not started')
    } catch (err) {
      console.warn('[location] no live updates, polling instead:', (err as Error).message)
      this.pollTimer = setInterval(() => void this.once().then(fix => fix && this.emit(fix, 'gps')), POLL_EVERY_MS)
    }
    if (!this.last) {
      const fake = fakeFix()
      if (fake) this.emit(fake, 'fake')
    }
  }

  stop() {
    clearInterval(this.pollTimer)
    this.unsubscribe?.()
    void this.bridge.stopAppLocationUpdates().catch(() => undefined)
  }

  private async once(): Promise<Fix | null> {
    try {
      return toFix(await this.bridge.getAppLocation({ accuracy: AppLocationAccuracy.Medium, timeoutMs: 5_000 }))
    } catch (err) {
      console.warn('[location] unavailable:', (err as Error).message)
      return null
    }
  }

  private emit(fix: Fix, source: 'gps' | 'fake') {
    this.last = fix
    this.onFix(fix, source)
  }
}
