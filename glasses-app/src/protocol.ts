// Contract 1 from Build Guide.md: phone <-> server over /ws. Audio goes as
// binary frames (raw s16le, 16 kHz, mono, as received from the G2); everything
// else is a JSON text frame carrying `v: 1`. Change only with C's OK.

export type ClientMessage =
  | { v: 1; type: 'hello'; session: string; source: 'glasses' | 'phone' }
  | { v: 1; type: 'control'; action: 'pause' | 'resume' }
  | { v: 1; type: 'ping' }

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
  source: 'spoken' | 'family'
}

export type ServerMessage =
  | Answer
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
    case 'clear':
    case 'status':
    case 'pong':
    case 'error':
      return msg as ServerMessage
    default:
      return null
  }
}
