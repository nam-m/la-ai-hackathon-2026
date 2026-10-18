import { waitForEvenAppBridge, type AudioEvent } from '@evenrealities/even_hub_sdk'
import { Mic, type MicState } from './audio'
import { RoleWindow, Recording, dbfs } from './debug'
import { Glasses } from './display'
import { gestureOf, type Gesture } from './gestures'
import { mountPhone } from './phone'
import type { ServerMessage } from './protocol'
import { ServerSocket, type SocketState } from './socket'
import { loadState, saveState } from './state'

const RECORD_SECONDS = 30

// Set once the glasses page exists; phone buttons and gestures do nothing before that.
let glasses: Glasses | undefined
let paused = false
let recording: Recording | null = null
// Whether the phone note shows a server status, which a lost link makes stale.
let statusNote = false
const roles = new RoleWindow()

// Mount the phone UI first so it shows something while the bridge comes up.
const phone = mountPhone({
  togglePause: () => void setPaused(!paused),
  showLast: () => glasses?.reshowLast(),
  record: startRecording,
})
phone.setNote('Waiting for the Even app...')

const bridge = await waitForEvenAppBridge()
const saved = await loadState(bridge)
paused = saved.paused

const socket = new ServerSocket({ onMessage: handleServer, onState: handleSocketState })
const mic = new Mic(bridge, { onChunk: handleChunk, onState: handleMicState })

try {
  glasses = await Glasses.create(bridge, view => phone.setView(view))
} catch (err) {
  phone.setNote((err as Error).message)
  throw err
}
glasses.restore(saved.lastAnswer)
phone.setLastAnswer(saved.lastAnswer)
glasses.setPaused(paused)
phone.setPaused(paused)
phone.setMic(mic.state, paused)
phone.setNote('')

const unsubscribe = bridge.onEvenHubEvent(event => {
  if (event.audioEvent) mic.handleChunk(event.audioEvent)
  const gesture = gestureOf(event)
  if (gesture) handleGesture(gesture)
})

let lastBytes = 0
const rateTimer = setInterval(() => {
  phone.setRate((socket.bytesSent - lastBytes) / 1024)
  lastBytes = socket.bytesSent
}, 1_000)

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resume()
})
window.addEventListener('beforeunload', cleanup)

socket.start()
// The glasses mic needs the startup page, which exists by now. Not awaited:
// a slow audioControl must not hold up anything else.
if (!paused) void mic.ensureOn()

function handleServer(msg: ServerMessage) {
  switch (msg.type) {
    case 'answer':
      glasses?.showAnswer(msg)
      phone.setLastAnswer(msg)
      persist()
      return
    case 'clear':
      glasses?.dismiss()
      return
    case 'status':
      phone.setNote(`Server: ${msg.text}`)
      statusNote = true
      return
    case 'error':
      console.warn('[server]', msg.code, msg.message)
      phone.setNote(`Server error ${msg.code}: ${msg.message}`)
      statusNote = false
      return
    case 'pong':
      return
  }
}

function handleSocketState(state: SocketState) {
  phone.setServer(state)
  glasses?.setConnected(state === 'open')
  // "Server: Listening" stops being true with the link; an error stays readable.
  if (state === 'closed' && statusNote) {
    phone.setNote('')
    statusNote = false
  }
  // Every new connection starts out listening on the server side.
  if (state === 'open' && paused) socket.send({ v: 1, type: 'control', action: 'pause' })
}

function handleMicState(state: MicState) {
  phone.setMic(state, paused)
  glasses?.setMicDenied(state === 'denied')
}

function handleChunk(event: AudioEvent) {
  socket.sendAudio(event.audioPcm, event.speakerRole)

  const level = dbfs(event.audioPcm)
  roles.push(event.speakerRole)
  phone.setLevel(level, event.speakerRole, event.direction, roles.counts())
  if (!recording) return
  const full = recording.push(event.audioPcm, { db: level, role: event.speakerRole, direction: event.direction })
  if (full) void finishRecording()
  else phone.setRecording(`Recording... ${Math.round(recording.progress * 100)}%`, true)
}

function handleGesture(gesture: Gesture) {
  switch (gesture) {
    case 'tap':
      // While the mic is blocked, tap is the retry once the wearer allows it.
      if (mic.state === 'denied') void mic.ensureOn()
      else glasses?.dismiss()
      return
    case 'double-tap':
      // The root page must use the system exit dialog (mode 1). Cleanup waits
      // for SYSTEM_EXIT_EVENT, since the wearer can still cancel.
      void bridge.shutDownPageContainer(1)
      return
    case 'swipe-up':
      glasses?.reshowLast()
      return
    case 'swipe-down':
      return
    case 'long-press':
      void setPaused(!paused)
      return
    case 'foreground':
      resume()
      return
    case 'exit':
      cleanup()
      return
  }
}

async function setPaused(next: boolean) {
  if (!glasses || next === paused) return
  paused = next
  glasses.setPaused(paused)
  phone.setPaused(paused)
  phone.setMic(mic.state, paused)
  socket.send({ v: 1, type: 'control', action: paused ? 'pause' : 'resume' })
  persist()
  if (paused && recording) {
    // No audio arrives while paused, so the recording could never finish.
    recording = null
    phone.setRecording('Recording stopped: paused.', false)
  }
  // Pause turns the mic fully off, not just the upload: nothing is heard while paused.
  if (paused) await mic.off()
  else await mic.ensureOn()
}

// Phone unlocked, WebView back in front, OS menu closed: re-check both links.
function resume() {
  if (!glasses) return
  socket.ensureConnected()
  if (!paused) void mic.ensureOn()
}

function persist() {
  saveState(bridge, { paused, lastAnswer: glasses?.lastAnswer ?? null })
}

function startRecording() {
  if (!glasses || recording) return
  if (paused || mic.state !== 'live') {
    phone.setRecording('Mic is not live. Resume first.', false)
    return
  }
  recording = new Recording(RECORD_SECONDS)
  phone.setRecording('Recording... 0%', true)
}

async function finishRecording() {
  const done = recording
  recording = null
  if (!done) return
  phone.setRecording('Uploading...', true)
  try {
    const name = await done.upload()
    phone.setRecording(`Saved dev/recordings/${name}.wav`, false)
  } catch (err) {
    phone.setRecording(`Upload failed: ${(err as Error).message}`, false)
  }
}

let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  clearInterval(rateTimer)
  unsubscribe()
  socket.stop()
  void mic.off()
}
