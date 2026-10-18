// Contract 1 from Build Guide.md: phone <-> server over /ws. Audio goes as
// binary frames (raw s16le, 16 kHz, mono, as received from the G2); everything
// else is a JSON text frame carrying `v: 1`. Change only with C's OK.

/** The glasses' own guess at who is speaking in an audio chunk (AudioEvent.speakerRole). */
export type SpeakerRole = 'self' | 'other' | 'unknown'

export const isSpeakerRole = (v: unknown): v is SpeakerRole => v === 'self' || v === 'other' || v === 'unknown'

export type ClientMessage =
  | { v: 1; type: 'hello'; session: string; source: 'glasses' | 'phone' }
  | { v: 1; type: 'control'; action: 'pause' | 'resume' }
  | { v: 1; type: 'ping' }
  // Applies to the audio frames that follow; sent when it changes. The server
  // uses it to tell the wearer's speech from other people's.
  | { v: 1; type: 'role'; role: SpeakerRole }
  // The phone's position, for "Where am I?". Sent when it changes and after each reconnect.
  | { v: 1; type: 'location'; latitude: number; longitude: number; accuracy: number | null; at: string }

export type Answer = {
  v: 1
  type: 'answer'
  id: string
  /** Word for word what a person said or the family typed. Never rewrite it. */
  text: string
  /** Null when the server has no names; the line then says when instead. */
  speaker: string | null
  /** Already formatted in the wearer's time zone, e.g. "10:40 AM". */
  at: string
  /** Set when the answer wasn't given today: "yesterday" or "on Friday". */
  day?: string
  /** location: built from the phone's GPS and map data when the wearer asks where they are. */
  source: 'spoken' | 'family' | 'location'
}

/** A remembered person is talking to the wearer now, recognized by voice. */
export type Speaker = { v: 1; type: 'speaker'; name: string; score: number }

export type ServerMessage =
  | Answer
  | Speaker
  | { v: 1; type: 'clear' }
  | { v: 1; type: 'status'; text: string }
  | { v: 1; type: 'pong' }
  | { v: 1; type: 'error'; code: 'stt_down' | 'bad_audio' | 'unauthorized'; message: string }

/** Parses one text frame; returns null for anything that isn't a known message. */
export function parseServerMessage(raw: string): ServerMessage | null {
  let msg: unknown
  try {
    msg = JSON.parse(raw)
  } catch {
    return null
  }
  if (!msg || typeof msg !== 'object') return null
  const fields = msg as Record<string, unknown>
  switch (fields.type) {
    case 'answer':
      return typeof fields.text === 'string' && typeof fields.at === 'string' ? (msg as Answer) : null
    case 'speaker':
      return typeof fields.name === 'string' && fields.name.trim() ? (msg as Speaker) : null
    case 'status':
      return typeof fields.text === 'string' ? (msg as ServerMessage) : null
    case 'error':
      return typeof fields.code === 'string' && typeof fields.message === 'string' ? (msg as ServerMessage) : null
    case 'clear':
    case 'pong':
      return msg as ServerMessage
    default:
      return null
  }
}
