# Rewind — glasses app (Part A)

The Even Hub app that runs on the phone. It streams the G2 microphone to the
team server over `/ws` and shows the answer to a repeated question low on the
glasses: who and when on a dim line, the answer word for word under it.

```
Sarah · 10:40 AM          (dim)
Lunch is at noon.
```

The protocol is Contract 1 in [`../Build Guide.md`](../Build%20Guide.md);
`src/protocol.ts` holds its types. The UI follows the
[Even Realities design guidelines](https://hub.evenrealities.com/docs/build/design-guidelines).

## Run it

```bash
npm install
npm run mock      # terminal 1: stand-in server on ws://localhost:8787/ws
npm run dev       # terminal 2: Vite on :5173, proxies /ws to the mock
```

Then either:

- **Simulator:** `npm run simulate` (uses the laptop mic).
- **Real G2:** `npx evenhub qr --url http://<laptop-ip>:5173` and scan it in
  the Even app. Find the IP with `ipconfig getifaddr en0`. On an IPv6-only
  network (some phone hotspots give the laptop `192.0.0.2`, which the phone
  can't reach), use the IPv6 address from `ifconfig en0` instead:
  `--url "http://[2607:...]:5173"`. Open the URL in the phone's browser first
  to check the phone can reach the laptop.

The mock logs the audio rate (the G2 sends about 31 kB/s) and sends a sample
answer every 20 s. Type `a` + Enter for an answer now, `c` to clear, `e` for
an `stt_down` error.

### Use C's server

Put its origin in `.env.local` (see `.env.example`) and restart `npm run dev`:

```bash
WS_TARGET=wss://<c-server-host>
```

The app keeps talking to same-origin `/ws` and Vite forwards it, so the
manifest whitelist doesn't matter in dev.

## On the glasses

| Gesture | Does |
| --- | --- |
| Tap | Dismiss the answer (or retry the mic if it was blocked) |
| Swipe up | Show the last answer again |
| Long press | Pause / resume. Pause turns the mic fully off and shows "Paused" |
| Double tap | Exit through the system dialog (required on the root page) |

Answers clear after 8 s or on a `clear` message. The display is blank
otherwise, except a dim "Paused", a blocked-mic message (retried every 15 s
and on tap), and a dim "offline" in the corner when the server has been
unreachable for more than 3 s. Without a speaker name the dim line reads
"Told you at 10:40 AM".

Design notes, from Even's guidelines and display docs:

- Full brightness only for the answer; who/when and status use `textColor` 2.
- The firmware font is proportional, has no sizes, and silently drops
  characters it lacks. `glassesSafe()` in `src/display.ts` keeps Latin-1 plus
  the UI glyphs the font has (`● ○ ▲ ▶ ━ ─ ╭ ╮ █` …) and swaps curly quotes,
  dashes and odd spaces for ASCII.
- Containers are sized for 27 px lines plus padding; text that overflows a
  container by a pixel grows a scrollbar.
- `ANSWER_MAX_CHARS` caps the answer at two lines; tune it on the real display
  with the mock's long sample answer.
- The phone screen uses the Even app's light-theme tokens (`TC-1st`, `BC-3rd`,
  6 px radius, 12/16/24 px spacing) in `src/phone.ts`.

## Debug panel (for B's loudness test)

On the phone screen, open **Debug: mic and loudness**. It shows the live level
in dBFS and the glasses' own `speakerRole` guess (`self` / `other` /
`unknown`) for every audio chunk. **Record 30 s** saves
`dev/recordings/g2-<time>.wav` plus a `.json` with level, role and direction
for every 100 ms chunk to the laptop. This works only from `npm run dev`.

Replay a recording to any server as if it came from the glasses:

```bash
npm run fake-phone -- --wav dev/recordings/g2-<time>.wav --url ws://localhost:8787/ws [--loop]
```

## Files

| File | What |
| --- | --- |
| `src/main.ts` | Startup order and wiring: bridge, glasses page, socket, mic, gestures |
| `src/socket.ts` | `/ws` client: hello, ping every 15 s, reconnect 1/2/4/10 s |
| `src/audio.ts` | Glasses mic with a watchdog that re-arms it after a stall |
| `src/display.ts` | Glasses layout, answer formatting, throttled BLE writes |
| `src/gestures.ts` | Bridge event to gesture mapping |
| `src/state.ts` | Pause state and last answer, kept across restarts (today only) |
| `src/phone.ts` | Phone screen: mirror, status, pause, debug panel |
| `src/debug.ts` | Level meter, speakerRole tally, recording |
| `dev/mock-server.ts` | Contract 1 mock |
| `dev/fake-phone.ts` | Streams a WAV to `/ws` like the app does |

## Before shipping the Beta

- Set `VITE_SERVER_URL=wss://<c-server-host>/ws` and put `wss://<c-server-host>`
  in the `network` whitelist in `app.json` (replace the placeholder).
- `npm run pack`, upload the `.ehpk`, install from **Me → Beta tester**.
- The 5-minute locked-phone test only works on a Beta install: QR dev builds
  die when the phone locks.
- The simulator doesn't send `SYSTEM_EXIT_EVENT`, so after a double tap it
  keeps streaming. Check exit cleanup on the real G2.
