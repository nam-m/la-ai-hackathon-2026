import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'

export type Gesture =
  | 'tap'
  | 'double-tap'
  | 'swipe-up'
  | 'swipe-down'
  | 'long-press'
  /** OS menu opened or closed over the app; not a teardown. */
  | 'foreground'
  | 'exit'

// CLICK_EVENT is 0 and protobuf drops zero-value fields, so a tap arrives as
// an envelope whose `eventType` is undefined. Default inside the envelope
// check only: events without that envelope (every audio frame) aren't taps.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

/** Maps one bridge event to the gesture it carries, if any. */
export function gestureOf(event: EvenHubEvent): Gesture | null {
  // Long press and lifecycle always arrive on sysEvent.
  switch (event.sysEvent?.eventType) {
    case OsEventTypeList.LONG_PRESS_EVENT:
      return 'long-press'
    case OsEventTypeList.FOREGROUND_ENTER_EVENT:
    case OsEventTypeList.FOREGROUND_EXIT_EVENT:
      return 'foreground'
    case OsEventTypeList.SYSTEM_EXIT_EVENT:
    case OsEventTypeList.ABNORMAL_EXIT_EVENT:
      return 'exit'
    case OsEventTypeList.LONG_PRESS_RELEASE_EVENT:
    case OsEventTypeList.IMU_DATA_REPORT:
      return null
  }

  // Taps come on sysEvent and swipes on textEvent from the capture layer, but
  // the docs disagree about taps, so check both. Double tap before tap.
  const sys = eventTypeOf(event.sysEvent)
  const text = eventTypeOf(event.textEvent)
  const either = (type: OsEventTypeList) => sys === type || text === type
  if (either(OsEventTypeList.DOUBLE_CLICK_EVENT)) return 'double-tap'
  if (either(OsEventTypeList.SCROLL_TOP_EVENT)) return 'swipe-up'
  if (either(OsEventTypeList.SCROLL_BOTTOM_EVENT)) return 'swipe-down'
  if (either(OsEventTypeList.CLICK_EVENT)) return 'tap'
  return null
}
