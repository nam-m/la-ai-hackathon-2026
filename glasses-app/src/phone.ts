import type { MicState } from './audio'
import { answerMeta, SEE_PHONE_TEXT, type GlassesView } from './display'
import type { Fix } from './location'
import type { Answer, Speaker } from './protocol'
import type { SocketState } from './socket'

type Actions = {
  togglePause(): void
  showLast(): void
  record(): void
}

type Tone = 'ok' | 'wait' | 'bad'

export type Phone = ReturnType<typeof mountPhone>

/**
 * The phone screen, styled after the Even app (Even Realities design
 * guidelines, light theme): a mirror of the glasses for the demo audience,
 * the last answer in full (the glasses say "See phone" when it is too long),
 * link status, pause, and a debug panel for B's loudness test.
 */
export function mountPhone(actions: Actions) {
  const app = document.querySelector<HTMLDivElement>('#app')!
  app.innerHTML = `
    <main class="page">
      <header class="header">
        <h1>Rewind</h1>
        <div class="chips">
          <span id="server" class="chip wait">Server</span>
          <span id="mic" class="chip wait">Mic</span>
        </div>
      </header>

      <section class="lens" aria-label="What the glasses show">
        <div class="lens-head">
          <span>On the glasses</span>
          <span id="corner" class="lens-corner"></span>
        </div>
        <div id="mirror-meta" class="lens-meta"></div>
        <div id="mirror" class="lens-line empty">Nothing shown</div>
      </section>

      <div class="actions">
        <button id="pause" class="button primary" type="button">Pause</button>
        <button id="show-last" class="button secondary" type="button">Show last</button>
      </div>
      <p id="note" class="note"></p>

      <section id="last" class="card last" aria-label="Last answer">
        <h2>Last answer</h2>
        <p id="last-meta" class="last-meta"></p>
        <p id="last-text" class="last-text empty">None yet</p>
      </section>

      <section class="card">
        <h2>On the glasses</h2>
        <dl class="gestures">
          <dt>Tap</dt><dd>Dismiss the answer</dd>
          <dt>Swipe up</dt><dd>Show the last answer again</dd>
          <dt>Hold</dt><dd>Pause or resume listening</dd>
          <dt>Double-tap</dt><dd>Exit</dd>
        </dl>
      </section>

      <details class="card">
        <summary>Debug: mic and loudness</summary>
        <div class="meter"><div id="meter-fill"></div></div>
        <dl class="readings">
          <dt>Level</dt><dd id="db">--</dd>
          <dt>Speaker role</dt><dd id="role">--</dd>
          <dt>Voice</dt><dd id="voice">--</dd>
          <dt>Location</dt><dd id="location">--</dd>
          <dt>Last 2 s</dt><dd id="roles">--</dd>
          <dt>Direction</dt><dd id="direction">--</dd>
          <dt>Sent</dt><dd id="rate">0.0 kB/s</dd>
        </dl>
        <button id="record" class="button secondary" type="button">Record 30 s</button>
        <p id="record-status" class="note"></p>
      </details>
    </main>
  `
  injectStyles()

  const el = <T extends HTMLElement = HTMLElement>(id: string) => app.querySelector<T>(`#${id}`)!
  const server = el('server')
  const mic = el('mic')
  const mirrorMeta = el('mirror-meta')
  const mirror = el('mirror')
  const corner = el('corner')
  const last = el('last')
  const lastMeta = el('last-meta')
  const lastText = el('last-text')
  const note = el('note')
  const pause = el<HTMLButtonElement>('pause')
  const record = el<HTMLButtonElement>('record')
  const recordStatus = el('record-status')
  const meterFill = el('meter-fill')
  const db = el('db')
  const role = el('role')
  const roles = el('roles')
  const voice = el('voice')
  const location = el('location')
  const direction = el('direction')
  const rate = el('rate')

  pause.onclick = () => actions.togglePause()
  el('show-last').onclick = () => actions.showLast()
  record.onclick = () => actions.record()
  // Recordings are saved by the Vite dev server; a packaged build has none.
  if (!import.meta.env.DEV) {
    record.disabled = true
    recordStatus.textContent = 'Recording works only when served by `npm run dev`.'
  }

  const chip = (node: HTMLElement, tone: Tone, text: string) => {
    node.className = `chip ${tone}`
    node.textContent = text
  }

  return {
    setServer(state: SocketState) {
      if (state === 'open') chip(server, 'ok', 'Server connected')
      else if (state === 'connecting') chip(server, 'wait', 'Connecting')
      else chip(server, 'bad', 'Server offline')
    },
    setMic(state: MicState, paused: boolean) {
      if (paused) chip(mic, 'wait', 'Mic paused')
      else if (state === 'live') chip(mic, 'ok', 'Mic live')
      else if (state === 'denied') chip(mic, 'bad', 'Mic blocked')
      else chip(mic, 'wait', state === 'starting' ? 'Mic starting' : 'Mic off')
    },
    setPaused(paused: boolean) {
      pause.textContent = paused ? 'Resume' : 'Pause'
    },
    setView(view: GlassesView) {
      mirrorMeta.textContent = view.meta
      mirror.textContent = view.line || (view.meta ? '' : 'Nothing shown')
      mirror.classList.toggle('empty', !view.line && !view.meta)
      corner.textContent = view.corner
      last.classList.toggle('attention', view.line === SEE_PHONE_TEXT)
    },
    /** The full answer, word for word: what "See phone" on the glasses points to. */
    setLastAnswer(answer: Answer | null) {
      lastMeta.textContent = answer ? answerMeta(answer) : ''
      lastText.textContent = answer ? answer.text : 'None yet'
      lastText.classList.toggle('empty', !answer)
    },
    setNote(text: string) {
      note.textContent = text
    },
    setLevel(level: number, speakerRole: string, dir: number | null, counts: Record<string, number>) {
      // Show -60..0 dBFS; quieter than that is room noise.
      meterFill.style.width = `${Math.max(0, Math.min(100, ((level + 60) / 60) * 100))}%`
      db.textContent = `${level.toFixed(1)} dBFS`
      role.textContent = speakerRole
      roles.textContent = Object.entries(counts).map(([name, n]) => `${name} ${n}`).join(' · ')
      direction.textContent = dir === null ? 'n/a' : String(dir)
    },
    /** Where the phone is, as sent to the server for "Where am I?". */
    setLocation(fix: Fix, source: 'gps' | 'fake') {
      const time = new Date(fix.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      location.textContent = `${fix.latitude.toFixed(5)}, ${fix.longitude.toFixed(5)}${fix.accuracy === null ? '' : ` ±${fix.accuracy} m`} (${time}${source === 'fake' ? ', fake' : ''})`
    },
    /** The last remembered person the server recognized by voice. */
    setSpeaker(speaker: Speaker) {
      voice.textContent = `${speaker.name} (${speaker.score.toFixed(2)}, ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })})`
    },
    setRate(kbPerSecond: number) {
      rate.textContent = `${kbPerSecond.toFixed(1)} kB/s`
    },
    setRecording(text: string, busy: boolean) {
      recordStatus.textContent = text
      if (import.meta.env.DEV) record.disabled = busy
    },
  }
}

function injectStyles() {
  // Tokens from the Even Realities design guidelines (light theme): TC = text
  // color, BC = background color, SC = shade. FK Grotesk Neue is Even's face;
  // it isn't bundled, so the system face stands in.
  const css = `
    :root {
      --tc-1st: #232323;
      --tc-2nd: #7B7B7B;
      --tc-highlight: #FFFFFF;
      --tc-green: #4BB956;
      --tc-red: #FF453A;
      --bc-1st: #FFFFFF;
      --bc-2nd: #F6F6F6;
      --bc-3rd: #EEEEEE;
      --bc-4th: #E4E4E4;
      --bc-highlight: #232323;
      --bc-accent: #FEF991;
      --sc-2nd: rgba(35, 35, 35, 0.08);
      --radius: 6px;
      --space-same: 6px;
      --space-cross: 12px;
      --space-card: 16px;
      --space-section: 24px;
      --font: "FK Grotesk Neue", -apple-system, BlinkMacSystemFont, "Helvetica Neue", system-ui, sans-serif;
      color-scheme: light;
    }
    html, body { margin: 0; min-height: 100%; background: var(--bc-3rd); color: var(--tc-1st);
      font: 300 15px/1.4 var(--font); letter-spacing: -0.01em;
      touch-action: manipulation; -webkit-text-size-adjust: 100%; overscroll-behavior: none; }
    .page { display: flex; flex-direction: column; gap: var(--space-cross);
      max-width: 640px; margin: 0 auto; box-sizing: border-box;
      padding: var(--space-section) var(--space-card); }
    .header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
      gap: var(--space-cross); margin-bottom: var(--space-same); }
    h1 { margin: 0; font-size: 24px; font-weight: 400; letter-spacing: -0.03em; }
    h2 { margin: 0 0 var(--space-cross); font-size: 15px; font-weight: 400; }
    .chips { display: flex; flex-wrap: wrap; gap: var(--space-same); }
    .chip { display: inline-flex; align-items: center; gap: var(--space-same);
      font-size: 13px; font-weight: 400; padding: 4px 10px; border-radius: var(--radius);
      background: var(--bc-1st); color: var(--tc-1st); white-space: nowrap; }
    .chip::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--tc-2nd); }
    .chip.ok::before { background: var(--tc-green); }
    .chip.bad::before { background: var(--tc-red); }

    /* The glasses' own look: green text on an unlit lens. */
    .lens { background: var(--bc-highlight); color: var(--tc-green); border-radius: var(--radius);
      padding: var(--space-card); min-height: 132px; display: flex; flex-direction: column; gap: var(--space-same); }
    .lens-head { display: flex; justify-content: space-between; font-size: 11px; font-weight: 400;
      color: var(--tc-2nd); margin-bottom: auto; }
    .lens-corner { color: var(--tc-green); opacity: 0.7; }
    .lens-meta { font-size: 15px; font-weight: 400; opacity: 0.7; min-height: 1em; }
    .lens-line { font-size: 22px; font-weight: 400; line-height: 1.3; word-break: break-word; }
    .lens-line.empty { color: var(--tc-2nd); font-size: 15px; }

    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-cross); }
    .button { font: 400 15px var(--font); border: 0; border-radius: var(--radius);
      min-height: 44px; padding: 0 var(--space-card); cursor: pointer; }
    .button.primary { background: var(--bc-highlight); color: var(--tc-highlight); }
    .button.secondary { background: var(--sc-2nd); color: var(--tc-1st); }
    .button:active { opacity: 0.8; }
    .button:disabled { opacity: 0.4; }
    .button:focus-visible { outline: 2px solid var(--tc-1st); outline-offset: 2px; }
    .note { margin: 0; font-size: 13px; font-weight: 400; color: var(--tc-2nd); min-height: 1em; }

    .card { background: var(--bc-1st); border-radius: var(--radius); padding: var(--space-card); }
    .last-meta { margin: 0 0 var(--space-same); font-size: 13px; font-weight: 400; color: var(--tc-2nd); }
    .last-meta:empty { display: none; }
    .last-text { margin: 0; font-size: 20px; font-weight: 400; line-height: 1.35; word-break: break-word; }
    .last-text.empty { font-size: 15px; color: var(--tc-2nd); }
    /* The glasses say "See phone": this card is where to look. */
    .card.last.attention { background: var(--bc-accent); }
    summary { font-size: 15px; font-weight: 400; cursor: pointer; }
    dl { display: grid; grid-template-columns: auto 1fr; gap: var(--space-same) var(--space-card); margin: 0; }
    dt { color: var(--tc-2nd); font-weight: 400; }
    dd { margin: 0; font-variant-numeric: tabular-nums; }
    .readings { margin: var(--space-cross) 0 var(--space-card); }
    .meter { height: 6px; margin-top: var(--space-card); background: var(--bc-3rd);
      border-radius: var(--radius); overflow: hidden; }
    #meter-fill { height: 100%; width: 0; background: var(--tc-1st); transition: width 80ms linear; }
    details .button { width: 100%; margin-bottom: var(--space-same); }
    @media (prefers-reduced-motion: reduce) { #meter-fill { transition: none; } }
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}
