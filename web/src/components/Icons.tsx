// Line icons: stroke follows the text color (currentColor). Decorative, so hidden from screen readers.
type P = { size?: number }
const Svg = ({ size = 16, viewBox = '0 0 16 16', children }: P & { viewBox?: string; children: React.ReactNode }) => (
  <svg width={size} height={size} viewBox={viewBox} aria-hidden="true">{children}</svg>
)

export const Check = (p: P) => <Svg {...p}><path d="M3 8.5l3 3 7-7.5" /></Svg>
export const Clock = (p: P) => <Svg {...p}><circle cx="8" cy="8" r="6" /><path d="M8 5v3.2l2 1.3" /></Svg>
export const Warn = (p: P) => <Svg {...p}><path d="M8 2l6.5 11.5h-13z" /><path d="M8 6.5v3M8 11.6v.1" /></Svg>
export const TrendUp = (p: P) => <Svg {...p}><path d="M2 11.5l4-4 3 3 5-5.5M10 5h4v4" /></Svg>
export const TrendDown = (p: P) => <Svg {...p}><path d="M2 4.5l4 4 3-3 5 5.5M10 11h4V7" /></Svg>
export const TrendFlat = (p: P) => <Svg {...p}><path d="M2 8h12" /></Svg>
export const Edit = (p: P) => <Svg {...p}><path d="M10.5 2.5l3 3L5 14H2v-3z" /></Svg>
export const Trash = (p: P) => <Svg {...p}><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9" /></Svg>
export const Sparkle = (p: P) => <Svg {...p}><path className="fill" d="M8 1.5l1.5 4.2 4.2 1.5-4.2 1.5L8 12.9 6.5 8.7 2.3 7.2l4.2-1.5z" /></Svg>
export const Plus = (p: P) => <Svg {...p}><path d="M8 3v10M3 8h10" /></Svg>

export const Sun = (p: P) => (
  <Svg viewBox="0 0 24 24" {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" /></Svg>
)
export const Bubble = (p: P) => (
  <Svg viewBox="0 0 24 24" {...p}><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4A1.5 1.5 0 0 1 4 14.5z" /></Svg>
)
export const Gear = (p: P) => (
  <Svg viewBox="0 0 24 24" {...p}><circle cx="12" cy="12" r="3" /><path d="M12 2.5l1.6 2.6 3-.6.7 3 2.6 1.6-1.4 2.9 1.4 2.9-2.6 1.6-.7 3-3-.6L12 21.5l-1.6-2.6-3 .6-.7-3-2.6-1.6 1.4-2.9-1.4-2.9 2.6-1.6.7-3 3 .6z" /></Svg>
)
export const Wave = (p: P) => <Svg viewBox="0 0 24 24" {...p}><path d="M3 12h2.5l2-5 3 10 3-14 3 12 2-3H21" /></Svg>
export const NoSignal = (p: P) => (
  <Svg viewBox="0 0 24 24" {...p}><path d="M2 8.5a15 15 0 0 1 20 0M5.5 12a10 10 0 0 1 13 0M9 15.5a5 5 0 0 1 6 0M3 3l18 18" /></Svg>
)
