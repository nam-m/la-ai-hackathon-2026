# Rewind family app

The caregiver frontend: Today (repeated questions, tone trend, AI summary, today's plan), Facts (what the glasses can say) and Settings (tone of voice on or off). React + Vite + TypeScript, talking to `server/` over HTTP. Design: Paper file "Happy pebble", Rewind artboards.

## Run it

```bash
cd server && npm run dev            # terminal 1: the API on :8080
cd web && npm install && npm run dev  # terminal 2: the app on :5173
```

Open http://localhost:5173 and enter the family key (the server's `FACTS_SECRET`), or open `http://localhost:5173/#key=<FACTS_SECRET>` to sign a browser in without typing it. The key stays in the URL fragment, so it never reaches server logs.

For a dashboard that's never empty, start the server with `DEMO_DATA=1 npm run dev`: a demo day is always there and real activity adds to it.

In dev, Vite proxies the API routes to `DEV_SERVER_URL` (default `http://localhost:8080`), so no CORS setup is needed.

## Deploy (Vercel, Netlify or any static host)

```bash
VITE_API_URL=https://your-server.onrender.com npm run build   # outputs dist/
```

`VITE_API_URL` is baked in at build time. The server already allows cross-origin calls (`Access-Control-Allow-Origin: *`). `VITE_WEARER_NAME` sets the wearer's name (default Rose).

## Files

| File | What it does |
| --- | --- |
| `src/api.ts` | Typed calls to `/health`, `/log/today`, `/facts`, `/summary/today`, `/creao/summary`, `/settings`; family key storage |
| `src/lib/useDashboard.ts` | Loads everything, refreshes every 15 s, tracks offline and signed-out states |
| `src/lib/worry.ts` | Tone readings to bar heights, colors and a plain-word trend (never a number) |
| `src/lib/facts.ts` | Fact form validation, expiry (empty = tonight), display wording |
| `src/pages/` | Today, Facts, Settings |
| `src/components/` | Header and tabs, sign-in, toast, icons |

`npm test` covers the trend and fact logic; `npm run build` type-checks and builds.
