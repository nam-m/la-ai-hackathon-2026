// Turns tone readings into what the family sees: bar heights, colors and a plain-word trend. Never a number.

/** Change in worry (0..1) between the first and last reading that counts as a trend. */
export const TREND_STEP = 0.15

export type Trend = { word: 'Getting more worried' | 'Calmer now' | 'Steady'; kind: 'worry' | 'good'; direction: 'up' | 'down' | 'flat' }

export function trendOf(worry: (number | null)[], toneOn: boolean): Trend | null {
  if (!toneOn) return null
  const readings = worry.filter((w): w is number => typeof w === 'number')
  if (readings.length < 2) return null
  const diff = readings[readings.length - 1] - readings[0]
  if (diff > TREND_STEP) return { word: 'Getting more worried', kind: 'worry', direction: 'up' }
  if (diff < -TREND_STEP) return { word: 'Calmer now', kind: 'good', direction: 'down' }
  return { word: 'Steady', kind: 'good', direction: 'flat' }
}

const clamp = (w: number) => Math.max(0, Math.min(1, w))

/** 10px (calm) to 40px (most worried). */
export const barHeight = (w: number) => Math.round(10 + clamp(w) * 30)

/** Light amber #F6D9A4 to deep amber #E3A64A. */
export function worryColor(w: number) {
  const t = clamp(w)
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t)
  return `rgb(${mix(246, 227)}, ${mix(217, 166)}, ${mix(164, 74)})`
}
