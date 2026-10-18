import {
  CreateStartUpPageContainer,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import type { Answer } from './protocol'

// About two lines of the answer container in the G2 font (not monospaced,
// ~27 px per line). Tune on the real display with the mock's long answer.
export const ANSWER_MAX_CHARS = 100
// Shown instead of an answer longer than that; the phone has it in full.
export const SEE_PHONE_TEXT = 'See phone'
const ANSWER_SHOW_MS = 8_000
// Short drops (server restart, Wi-Fi blip) reconnect within a second or two;
// only flag an outage that lasts.
const OFFLINE_AFTER_MS = 3_000
// The BLE link can't take back-to-back text writes.
const WRITE_GAP_MS = 150
// Even's guidelines: full brightness for what matters, dimmer for secondary text.
const DIM = 2

const PAUSED_TEXT = 'Paused'
const MIC_DENIED_TEXT = 'Mic is off. Allow it in the Even app, then tap.'
const OFFLINE_TEXT = 'offline'

const ID = { events: 1, meta: 2, answer: 3, corner: 4 } as const

/** What the glasses show right now, mirrored on the phone. */
export type GlassesView = { meta: string; line: string; corner: string }

// Everything sits low in the field of view, so the wearer still sees the face
// in front of them: a dim "who and when" line, then up to two lines of answer.
// Heights leave room for 27 px lines plus padding: a container whose text
// overflows by even a pixel grows a scrollbar.
function layout() {
  return {
    containerTotalNum: 4,
    textObject: [
      // Blank full-screen layer that owns input, so gestures work whatever is shown.
      new TextContainerProperty({
        xPosition: 0, yPosition: 0, width: 576, height: 288,
        borderWidth: 0, paddingLength: 0,
        containerID: ID.events, containerName: 'events',
        content: ' ', isEventCapture: 1, zOrderIndex: 1,
      }),
      new TextContainerProperty({
        xPosition: 8, yPosition: 174, width: 560, height: 40,
        borderWidth: 0, paddingLength: 4,
        containerID: ID.meta, containerName: 'meta',
        content: ' ', isEventCapture: 0, zOrderIndex: 2, textColor: DIM,
      }),
      new TextContainerProperty({
        xPosition: 8, yPosition: 214, width: 560, height: 70,
        borderWidth: 0, paddingLength: 4,
        containerID: ID.answer, containerName: 'answer',
        content: ' ', isEventCapture: 0, zOrderIndex: 3,
      }),
      new TextContainerProperty({
        xPosition: 456, yPosition: 4, width: 116, height: 40,
        borderWidth: 0, paddingLength: 4,
        containerID: ID.corner, containerName: 'corner',
        content: ' ', isEventCapture: 0, zOrderIndex: 4, textColor: DIM,
      }),
    ],
  }
}

/**
 * The glasses display. Stays blank unless there is an answer to show, the
 * wearer paused, the mic is blocked, or the server has been gone for a while.
 */
export class Glasses {
  private answer: Answer | null = null
  private answerVisible = false
  private paused = false
  private micDenied = false
  private offline = false
  private hideTimer: ReturnType<typeof setTimeout> | undefined
  private offlineTimer: ReturnType<typeof setTimeout> | undefined
  private readonly meta: TextSlot
  private readonly line: TextSlot
  private readonly corner: TextSlot

  private constructor(
    bridge: EvenAppBridge,
    private readonly onView: (view: GlassesView) => void,
  ) {
    this.meta = new TextSlot(bridge, ID.meta, 'meta')
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
    let view: GlassesView = { meta: '', line: '', corner: this.offline ? OFFLINE_TEXT : '' }
    if (this.micDenied) view.line = MIC_DENIED_TEXT
    else if (this.paused) view.meta = PAUSED_TEXT
    else if (this.answerVisible && this.answer) view = { ...view, ...answerLines(this.answer) }
    this.meta.set(view.meta)
    this.line.set(view.line)
    this.corner.set(view.corner)
    this.onView({ meta: glassesSafe(view.meta), line: glassesSafe(view.line), corner: view.corner })
  }
}

/**
 * The answer word for word, under a dim line with who said it and when. An
 * answer too long for two lines is never shortened, since any cut can drop a
 * "not" or half an instruction (spec v4.1): the glasses say "See phone"
 * instead. Who and when stay either way; they make the answer trustworthy.
 */
export function answerLines(answer: Answer, max = ANSWER_MAX_CHARS): { meta: string; line: string } {
  const text = oneLine(answer.text)
  return { meta: answerMeta(answer), line: glassesSafe(text).length <= max ? text : SEE_PHONE_TEXT }
}

/** "Sarah · 10:40 AM", or "Told you at 10:40 AM" without a speaker (Contract 1). */
export function answerMeta(answer: Answer): string {
  return oneLine(answer.speaker ? `${answer.speaker} · ${answer.at}` : `Told you at ${answer.at}`)
}

// Line breaks from the server would need lines the containers don't have.
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

// Code points the G2 firmware font can draw; it silently drops everything
// else. Printable ASCII and Latin-1 minus five glyphs, plus the UI symbols
// from Even's design guidelines and the community glyph tables
// (github.com/nickustinov/even-g2-notes, docs/display.md).
const FONT = new Set<number>()
function addGlyphs(from: number, to = from) {
  for (let cp = from; cp <= to; cp++) FONT.add(cp)
}
addGlyphs(0x0a) // line break
addGlyphs(0x20, 0x7e)
addGlyphs(0xa0, 0xff)
for (const missing of [0xa8, 0xaf, 0xb4, 0xb5, 0xb8]) FONT.delete(missing)
addGlyphs(0x2190, 0x2199) // arrows
addGlyphs(0x21d2)
addGlyphs(0x21d4)
addGlyphs(0x2500, 0x2503) // box drawing
addGlyphs(0x250c, 0x254b)
addGlyphs(0x2550)
addGlyphs(0x255e)
addGlyphs(0x2561)
addGlyphs(0x256a)
addGlyphs(0x256d, 0x2573)
addGlyphs(0x2581, 0x258f) // blocks, for meters
addGlyphs(0x2592)
addGlyphs(0x2594, 0x2595)
for (const shape of [0x25a0, 0x25a1, 0x25b2, 0x25b3, 0x25b6, 0x25b7, 0x25bc, 0x25bd, 0x25c0, 0x25c1, 0x25ca, 0x25ef]) {
  addGlyphs(shape)
}
addGlyphs(0x25a3, 0x25a9)
addGlyphs(0x25c6, 0x25c8)
addGlyphs(0x25cb, 0x25cc)
addGlyphs(0x25ce, 0x25d1)
addGlyphs(0x25e2, 0x25e5)
for (const symbol of [0x2605, 0x2606, 0x2609, 0x260e, 0x260f, 0x261c, 0x261e, 0x2660, 0x2661, 0x2667]) {
  addGlyphs(symbol)
}
addGlyphs(0x2663, 0x2665)
for (const typographic of [0x2020, 0x203b, 0x2122, 0x221e, 0x2070, 0x215b]) addGlyphs(typographic)
addGlyphs(0x2074, 0x2079) // superscripts
addGlyphs(0x2080, 0x2089) // subscripts

// Typography the font lacks but has a close stand-in for. Odd spaces matter:
// toLocaleTimeString puts U+202F before "AM".
function standIn(cp: number): string | null {
  if ((cp >= 0x2000 && cp <= 0x200a) || cp === 0x202f || cp === 0x205f) return ' '
  switch (cp) {
    case 0x2018:
    case 0x2019:
      return "'"
    case 0x201c:
    case 0x201d:
      return '"'
    case 0x2013:
    case 0x2014:
      return '-'
    case 0x2022:
      return '·'
    case 0x2026:
      return '...'
    default:
      return null
  }
}

/** Text as the glasses will draw it: stand-ins for missing typography, other unsupported characters removed. */
export function glassesSafe(text: string): string {
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    const sub = standIn(cp)
    if (sub !== null) out += sub
    else if (FONT.has(cp)) out += ch
  }
  return out
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
