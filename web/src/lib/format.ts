export const WEARER = import.meta.env.VITE_WEARER_NAME || 'Rose'

/** "2:31 PM" in the viewer's time zone. */
export const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

export function endOfToday(now = new Date()) {
  const d = new Date(now)
  d.setHours(23, 59, 0, 0)
  return d
}

export function greetingWord(now = new Date()) {
  const h = now.getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}
