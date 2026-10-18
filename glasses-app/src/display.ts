import {
  CreateStartUpPageContainer,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import type { Answer } from './protocol'

// About two lines of the bottom container in the G2 font (not monospaced,
// ~27 px per line). Tune on the real display with the mock's long answer.
export const ANSWER_MAX_CHARS = 96
const ANSWER_SHOW_MS = 8_000
// Short drops (server restart, Wi-Fi blip) reconnect within a second or two;
// only flag an outage that lasts.
const OFFLINE_AFTER_MS = 3_000
// The BLE link can't take back-to-back text writes.
const WRITE_GAP_MS = 150

const PAUSED_TEXT = 'Paused'
const MIC_DENIED_TEXT = 'Mic is off. Allow it in the Even app, then tap.'
const OFFLINE_TEXT = 'offline'

const ID = { events: 1, answer: 2, corner: 3 } as const

/** What the glasses show right now, mirrored on the phone. */
export type GlassesView = { line: string; corner: string }

function layout() {
  return {
    containerTotalNum: 3,
    textObject: [
      // Blank full-screen layer that owns input, so gestures work whatever is shown.
      new TextContainerProperty({
        xPosition: 0, yPosition: 0, width: 576, height: 288,
        borderWidth: 0, paddingLength: 0,
        containerID: ID.events, containerName: 'events',
        content: ' ', isEventCapture: 1, zOrderIndex: 1,
      }),
      // Low in the field of view, so the wearer still sees the face in front of them.
      new TextContainerProperty({
        xPosition: 8, yPosition: 214, width: 560, height: 70,
        borderWidth: 0, paddingLength: 4,
        containerID: ID.answer, containerName: 'answer',
        content: ' ', isEventCapture: 0, zOrderIndex: 2,
      }),
      new TextContainerProperty({
        xPosition: 456, yPosition: 4, width: 116, height: 36,
        borderWidth: 0, paddingLength: 4,
        containerID: ID.corner, containerName: 'corner',
        content: ' ', isEventCapture: 0, zOrderIndex: 3, textColor: 2,
      }),
    ],
  }
}

/**
 * The glasses display: one answer area plus a corner flag. Stays blank unless
 * there is an answer to show, the wearer paused, or the mic is blocked.
 */
export class Glasses {
  private answer: Answer | null = null
  private answerVisible = false
  private paused = false
  private micDenied = false
  private offline = false
  private hideTimer: ReturnType<typeof setTimeout> | undefined
  private offlineTimer: ReturnType<typeof setTimeout> | undefined
  private readonly line: TextSlot
  private readonly corner: TextSlot

  private constructor(
    bridge: EvenAppBridge,
    private readonly onView: (view: GlassesView) => void,
  ) {
    this.line = new TextSlot(bridge, ID.answer, 'answer')
    this.corner = new TextSlot(bridge, ID.corner, 'corner')
  }

  static async create(bridge: EvenAppBridge, onView: (view: GlassesView) => void): Promise<Glasses> {
    const created = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(layout()))
    if (created !== StartUpPageCreateResult.success) {
      // The startup page can be created once per session. After a Vite reload
      // the old page is still on the glasses, so swap the layout in instead.
      const rebuilt = await bridge.rebuildPageContainer(new RebuildPageContainer(layout()))
      if (!rebuilt) throw new Error(`glasses page setup failed (create result ${created})`)
    }
    return new Glasses(bridge, onView)
  }

  get lastAnswer(): Answer | null {
    return this.answer
  }

  /** Remembers an answer for swipe-up without showing it (state restored after a restart). */
  restore(answer: Answer | null) {
    this.answer = answer
  }

  showAnswer(answer: Answer) {
    this.answer = answer
    this.reveal()
  }

  /** Shows the last answer again; false when there is none. */
  reshowLast(): boolean {
    if (!this.answer) return false
    this.reveal()
    return true
  }

  dismiss() {
    clearTimeout(this.hideTimer)
    this.answerVisible = false
    this.render()
  }

  setPaused(paused: boolean) {
    this.paused = paused
    this.render()
  }

  setMicDenied(denied: boolean) {
    this.micDenied = denied
    this.render()
  }

  setConnected(connected: boolean) {
    if (connected) {
      clearTimeout(this.offlineTimer)
      this.offlineTimer = undefined
      if (this.offline) {
        this.offline = false
        this.render()
      }
      return
    }
    // Keep the first pending timer: reconnect attempts cycle closed/connecting
    // faster than OFFLINE_AFTER_MS and must not keep pushing it back.
    if (this.offline || this.offlineTimer) return
    this.offlineTimer = setTimeout(() => {
      this.offlineTimer = undefined
      this.offline = true
      this.render()
    }, OFFLINE_AFTER_MS)
  }

  private reveal() {
    clearTimeout(this.hideTimer)
    this.answerVisible = true
    this.render()
    this.hideTimer = setTimeout(() => this.dismiss(), ANSWER_SHOW_MS)
  }

  private render() {
    let line = ''
    if (this.micDenied) line = MIC_DENIED_TEXT
    else if (this.paused) line = PAUSED_TEXT
    else if (this.answerVisible && this.answer) line = formatAnswer(this.answer)
    const corner = this.offline ? OFFLINE_TEXT : ''
    this.line.set(line)
    this.corner.set(corner)
    this.onView({ line: glassesSafe(line), corner })
  }
}

/**
 * `text, speaker, at`, or `text (told you at <at>)` without a speaker
 * (Contract 1). Only the answer text is shortened: who and when always show,
 * because they are what make the answer trustworthy.
 */
export function formatAnswer(answer: Answer, max = ANSWER_MAX_CHARS): string {
  const tail = answer.speaker ? `, ${answer.speaker}, ${answer.at}` : ` (told you at ${answer.at})`
  const text = answer.text.trim().replace(/[.,;]+$/, '')
  return clip(text, Math.max(12, max - tail.length)) + tail
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 3)
  const space = cut.lastIndexOf(' ')
  return `${space > max / 2 ? cut.slice(0, space) : cut}...`
}

// The firmware font covers printable ASCII and most of Latin-1 and silently
// drops everything else, so fold common typography to ASCII first. Odd spaces
// matter: toLocaleTimeString puts U+202F before "AM".
export function glassesSafe(text: string): string {
  return text
    .replace(/[ -   ]/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\n\x20-\x7e\xa0-\xff]|[\xa8\xaf\xb4\xb5\xb8]/g, '')
}

// One text container, last write wins: at most one BLE write in flight, and
// it always settles on the newest text.
class TextSlot {
  private shown = ' '
  private next: string | null = null
  private busy = false

  constructor(
    private readonly bridge: EvenAppBridge,
    private readonly id: number,
    private readonly name: string,
  ) {}

  set(text: string) {
    // An empty string isn't a valid container content; a space blanks it.
    const content = glassesSafe(text) || ' '
    if (content === (this.next ?? this.shown)) return
    this.next = content
    if (!this.busy) void this.drain()
  }

  private async drain() {
    this.busy = true
    while (this.next !== null) {
      const content = this.next
      this.next = null
      try {
        await this.bridge.textContainerUpgrade(
          new TextContainerUpgrade({ containerID: this.id, containerName: this.name, content }),
        )
        this.shown = content
      } catch (err) {
        console.error(`[display] write to ${this.name} failed`, err)
      }
      await new Promise(resolve => setTimeout(resolve, WRITE_GAP_MS))
    }
    this.busy = false
  }
}
