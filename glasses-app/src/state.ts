import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { Answer } from './protocol'

// What must survive the WebView being killed: Android reclaims it in the
// background, and the app then starts cold.
const KEY = 'rewind.state'

export type SavedState = { paused: boolean; lastAnswer: Answer | null }

type Stored = SavedState & { day: string }

// Answers are good for today only (team plan, trust rule 4).
const today = () => new Date().toDateString()

export async function loadState(bridge: EvenAppBridge): Promise<SavedState> {
  try {
    const raw = await bridge.getLocalStorage(KEY)
    if (raw) {
      const stored = JSON.parse(raw) as Partial<Stored>
      return {
        paused: stored.paused === true,
        lastAnswer: stored.day === today() ? stored.lastAnswer ?? null : null,
      }
    }
  } catch (err) {
    console.warn('[state] load failed', err)
  }
  return { paused: false, lastAnswer: null }
}

export function saveState(bridge: EvenAppBridge, state: SavedState) {
  const stored: Stored = { ...state, day: today() }
  bridge.setLocalStorage(KEY, JSON.stringify(stored)).catch(err => console.warn('[state] save failed', err))
}
