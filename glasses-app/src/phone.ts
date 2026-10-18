import type { MicState } from './audio'
import type { GlassesView } from './display'
import type { SocketState } from './socket'

type Actions = {
  togglePause(): void
  showLast(): void
  record(): void
}

type Tone = 'ok' | 'wait' | 'bad'

export type Phone = ReturnType<typeof mountPhone>

/**
 * The phone screen: a big mirror of the glasses line (for the demo audience),
 * link status, pause, and a debug panel for B's loudness test.
 */
export function mountPhone(actions: Actions) {
  const app = document.querySelector<HTMLDivElement>('#app')!
  app.innerHTML = `
    <main class="panel">
      <header>
        <h1>Rewind</h1>
        <div class="pills">
          <span id="server" class="pill wait">Server</span>
          <span id="mic" class="pill wait">Mic</span>
        </div>
      </header>
      <section class="card">
        <div class="label">On the glasses <span id="corner" class="corner"></span></div>
        <div id="mirror" class="mirror empty">Nothing shown</div>
      </section>
      <div class="actions">
        <button id="pause" type="button">Pause</button>
        <button id="show-last" type="button">Show last</button>
      </div>
      <p id="note" class="note"></p>
      <details class="card">
        <summary>Debug: mic and loudness</summary>
        <div class="meter"><div id="meter-fill"></div></div>
        <dl>
          <dt>Level</dt><dd id="db">--</dd>
          <dt>Speaker role</dt><dd id="role">--</dd>
          <dt>Last 2 s</dt><dd id="roles">--</dd>
          <dt>Direction</dt><dd id="direction">--</dd>
          <dt>Sent</dt><dd id="rate">0.0 kB/s</dd>
        </dl>
        <button id="record" type="button">Record 30 s</button>
        <p id="record-status" class="note"></p>
      </details>
      <footer>Tap: dismiss · Swipe up: show again · Hold: pause · Double-tap: exit</footer>
    </main>
  `
  injectStyles()

  const el = <T extends HTMLElement = HTMLElement>(id: string) => app.querySelector<T>(`#${id}`)!
  const server = el('server')
  const mic = el('mic')
  const mirror = el('mirror')
  const corner = el('corner')
  const note = el('note')
  const pause = el<HTMLButtonElement>('pause')
  const record = el<HTMLButtonElement>('record')
  const recordStatus = el('record-status')
  const meterFill = el('meter-fill')
  const db = el('db')
  const role = el('role')
  const roles = el('roles')
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

  const pill = (node: HTMLElement, tone: Tone, text: string) => {
    node.className = `pill ${tone}`
    node.textContent = text
  }

  return {
    setServer(state: SocketState) {
      if (state === 'open') pill(server, 'ok', 'Server connected')
      else if (state === 'connecting') pill(server, 'wait', 'Server connecting')
      else pill(server, 'bad', 'Server offline')
    },
    setMic(state: MicState, paused: boolean) {
      if (paused) pill(mic, 'wait', 'Mic paused')
      else if (state === 'live') pill(mic, 'ok', 'Mic live')
      else if (state === 'denied') pill(mic, 'bad', 'Mic blocked')
      else pill(mic, 'wait', state === 'starting' ? 'Mic starting' : 'Mic off')
    },
    setPaused(paused: boolean) {
      pause.textContent = paused ? 'Resume' : 'Pause'
    },
    setView(view: GlassesView) {
      mirror.textContent = view.line || 'Nothing shown'
      mirror.classList.toggle('empty', !view.line)
      corner.textContent = view.corner
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
  // ER brand dark-theme surfaces: #232323 / #2E2E2E / #3E3E3E.
  // ER OS green (#3CFA44) + signal red (#FF453A) for state chips.
  const css = `
    :root { color-scheme: dark; }
    html, body { margin: 0; min-height: 100%; background: #232323; color: #E5E5E5;
      font: 16px/1.4 -apple-system, BlinkMacSystemFont, 'Helvetica Neue', system-ui, sans-serif;
      touch-action: manipulation; -webkit-text-size-adjust: 100%;
      overscroll-behavior: none; }
    .panel { display: flex; flex-direction: column; gap: 16px;
      width: 100%; max-width: 640px; margin: 0 auto; padding: 24px 16px; box-sizing: border-box; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    h1 { font-size: 18px; font-weight: 600; margin: 0; letter-spacing: 0.02em; }
    .pills { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .pill { font-size: 11px; padding: 4px 10px; border-radius: 999px; white-space: nowrap;
      border: 1px solid transparent; letter-spacing: 0.04em; text-transform: uppercase; }
    .pill.wait { color: #A7A7A7; border-color: #3E3E3E; }
    .pill.ok   { color: #3CFA44; border-color: #3CFA44; background: rgba(60,250,68,0.08); }
    .pill.bad  { color: #FF453A; border-color: #FF453A; background: rgba(255,69,58,0.08); }
    .card { background: #2E2E2E; border: 1px solid #3E3E3E; border-radius: 12px; padding: 16px; }
    .label { font-size: 12px; color: #7B7B7B; text-transform: uppercase; letter-spacing: 0.04em;
      display: flex; justify-content: space-between; }
    .corner { color: #FF453A; }
    .mirror { margin-top: 12px; min-height: 96px; font-size: 26px; line-height: 1.3;
      color: #3CFA44; word-break: break-word; }
    .mirror.empty { color: #5A5A5A; font-size: 18px; }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    button { font: inherit; font-weight: 600; color: #E5E5E5; background: #3E3E3E; border: 0;
      border-radius: 10px; padding: 14px; }
    button:active { background: #4E4E4E; }
    button:disabled { opacity: 0.4; }
    .note { margin: 0; font-size: 13px; color: #A7A7A7; min-height: 1em; }
    summary { font-size: 14px; color: #A7A7A7; }
    .meter { height: 10px; margin: 16px 0 8px; background: #232323; border-radius: 5px; overflow: hidden; }
    #meter-fill { height: 100%; width: 0; background: #3CFA44; transition: width 80ms linear; }
    dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 12px 0 16px; font-size: 14px; }
    dt { color: #7B7B7B; }
    dd { margin: 0; font-variant-numeric: tabular-nums; }
    details button { width: 100%; margin-bottom: 8px; }
    footer { font-size: 12px; color: #7B7B7B; text-align: center; }
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}
