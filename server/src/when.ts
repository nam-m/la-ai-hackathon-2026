// Which day a question or answer is about ("Dinner tomorrow is at 7"), in the wearer's time zone.
// Plain patterns, no model: a wrong day would hide a right answer or show a wrong one.
import { localDate } from './store.js'

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

/** Local YYYY-MM-DD, `days` after today. Date math on noon UTC so daylight saving can't shift the day. */
export function localDay(now = new Date(), days = 0) {
  const d = new Date(`${localDate(now.toISOString())}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** The local day the text names, or null when it names none (then it is about the day it was said). */
export function dayOf(text: string, now = new Date()): string | null {
  const t = text.toLowerCase()
  if (/\byesterday\b|\blast (night|week)\b/.test(t)) return null
  if (/\bday after tomorrow\b/.test(t)) return localDay(now, 2)
  if (/\btomorrow\b/.test(t)) return localDay(now, 1)
  if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(t)) return localDay(now)
  const m = /\b(next |this |on )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/.exec(t)
  if (!m) return null
  const todayIndex = new Date(`${localDay(now)}T12:00:00Z`).getUTCDay()
  let ahead = (WEEKDAYS.indexOf(m[2]) - todayIndex + 7) % 7
  if (ahead === 0 && m[1] === 'next ') ahead = 7
  return localDay(now, ahead)
}

/** "yesterday", "on Friday" or "on Oct 12" for a time before today; undefined for today. */
export function dayLabel(iso: string, now = new Date()): string | undefined {
  const day = localDate(iso)
  if (day >= localDay(now)) return undefined
  if (day === localDay(now, -1)) return 'yesterday'
  const d = new Date(`${day}T12:00:00Z`)
  if (day >= localDay(now, -6)) return `on ${d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })}`
  return `on ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`
}
