// Coordinates -> a place a person would recognize, via OpenStreetMap Nominatim (reverse geocoding).
// Free and keyless, but at most one request per second and an identifying User-Agent (their usage policy).
import { config } from '../config.js'

export type Place = {
  /** A named area the point is inside (a building, park, hospital, campus); not a nearby shop. */
  area: string | null
  street: string | null // "308 Westwood Plaza", or just the road
  houseNumber: boolean
  neighborhood: string | null
  city: string | null
  display: string
}

type NominatimReply = {
  name?: string
  osm_type?: string
  display_name?: string
  address?: Record<string, string>
  error?: string
}

const USER_AGENT = 'Rewind (LA Hacks 2026 demo)'
const cache = new Map<string, Promise<Place | null>>()
let nextSlot = 0

// About 50 m cells, so small GPS jitter reuses the answer instead of asking again.
const cellOf = (lat: number, lon: number) => `${Math.round(lat * 2000)},${Math.round(lon * 2000)}`

export function toPlace(json: NominatimReply): Place | null {
  if (!json || json.error || !json.address) return null
  const a = json.address
  const road = a.road ?? a.pedestrian ?? a.footway ?? a.path ?? null
  return {
    // A point of interest next to the wearer would mislead ("You're at Carl's Jr."); an area they are inside doesn't.
    area: json.name && (json.osm_type === 'way' || json.osm_type === 'relation') ? json.name : null,
    street: road ? (a.house_number ? `${a.house_number} ${road}` : road) : null,
    houseNumber: Boolean(road && a.house_number),
    neighborhood: a.neighbourhood ?? a.quarter ?? a.suburb ?? null,
    city: a.city ?? a.town ?? a.village ?? a.hamlet ?? null,
    display: json.display_name ?? '',
  }
}

/** The place at these coordinates, or null when the lookup fails (not cached then, so it is tried again). */
export function reverseGeocode(lat: number, lon: number): Promise<Place | null> {
  const key = cellOf(lat, lon)
  const hit = cache.get(key)
  if (hit) return hit
  const job = (async () => {
    const wait = Math.max(0, nextSlot - Date.now())
    nextSlot = Date.now() + wait + 1100
    if (wait) await new Promise(done => setTimeout(done, wait))
    const url = `${config.nominatimUrl.replace(/\/$/, '')}/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1&accept-language=en`
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(4000) })
    if (!res.ok) throw new Error(`nominatim ${res.status}`)
    return toPlace((await res.json()) as NominatimReply)
  })().catch(e => {
    console.warn(`[location] reverse geocoding failed: ${(e as Error).message}`)
    return null
  })
  cache.set(key, job)
  void job.then(place => { if (!place) cache.delete(key) })
  if (cache.size > 500) cache.delete(cache.keys().next().value!)
  return job
}
