// Where the app finds the team server (Contract 1 in Build Guide.md).
//
// In dev the WebView loads the app from Vite on the laptop, so the default is
// same-origin /ws and Vite proxies it to WS_TARGET (the mock or C's server).
// Same-origin needs no manifest whitelist entry. A packaged .ehpk has no Vite
// behind it: set VITE_SERVER_URL to the absolute wss:// URL and whitelist its
// origin in app.json.
function sameOriginWs(): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${location.host}/ws`
}

export const SERVER_URL = import.meta.env.VITE_SERVER_URL || sameOriginWs()
// Only keeps random clients out; not a secret, since the bundle is public.
export const APP_TOKEN = import.meta.env.VITE_APP_TOKEN || 'dev'
export const SESSION = import.meta.env.VITE_SESSION || 'demo-1'
