// "Where am I?": answered from the phone's GPS and map data, never by a language model. The glasses label it
// "Location · <time of the fix>", so it isn't mistaken for something a person said.
import type { Home } from '../store.js'
import type { Place } from './geocode.js'

export type Fix = { lat: number; lon: number; accuracy: number | null; at: string }

const ANSWER_MAX_CHARS = 100 // the glasses' two lines (glasses-app/src/display.ts); longer says "See phone"
const HOME_RADIUS_M = 100

// Whole-question patterns only, so "Where are we going today?" still goes to the matcher.
const WHERE_AM_I = /^(?:(?:um|uh|so|okay|ok|hey|wait|sorry)[,.]?\s+)*(?:where am i|where are we|what is this place|what's this place|what place is this|where is this|where's this)(?:\s+(?:right\s+)?now)?(?:\s+again)?\s*[?.!]*$/i

export const isWhereAmI = (text: string) => WHERE_AM_I.test(text.trim())

/** Meters between two points (haversine). */
export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const rad = (d: number) => (d * Math.PI) / 180
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h))
}

export const isHome = (fix: Fix, home: Home) => distanceM(fix, home) <= Math.max(HOME_RADIUS_M, Math.min(fix.accuracy ?? 0, 250))

function fromHome(meters: number) {
  const miles = meters / 1609.344
  if (miles < 0.2) return 'a short walk from home'
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} miles from home`
}

/** What the glasses say, or null when there is nothing trustworthy to say. */
export function locationText(fix: Fix, place: Place | null, home: Home | null): string | null {
  if (home && isHome(fix, home)) return "You're at home."
  const where = place?.area ?? place?.street ?? null
  const at = place?.area || place?.houseNumber ? 'at' : 'on' // "at 308 Westwood Plaza", "on Westwood Plaza"
  const town = place?.neighborhood ?? place?.city ?? null
  const options: string[] = []
  if (where && home) options.push(`You're ${at} ${where}, ${fromHome(distanceM(fix, home))}.`)
  if (where && town && town !== where) options.push(`You're ${at} ${where}, ${town}.`)
  if (where) options.push(`You're ${at} ${where}.`)
  if (!where && town && home) options.push(`You're in ${town}, ${fromHome(distanceM(fix, home))}.`)
  if (!where && town) options.push(`You're in ${town}.`)
  if (!where && !town && home) options.push(`You're ${fromHome(distanceM(fix, home))}.`)
  return options.find(t => t.length <= ANSWER_MAX_CHARS) ?? null
}
