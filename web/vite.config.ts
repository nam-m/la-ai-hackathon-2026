import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// In dev, the server's API routes are proxied so the app can call them same-origin (VITE_API_URL left empty).
const API_ROUTES = ['/health', '/log', '/facts', '/summary', '/settings', '/creao']

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  const target = env.DEV_SERVER_URL || 'http://localhost:8080'
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: Object.fromEntries(API_ROUTES.map(r => [r, {
        target, changeOrigin: true,
        // Server not running: answer 502 like a real host would, so the app shows "can't reach" (Vite's default is 500).
        configure: (proxy: { on: (event: 'error', fn: (err: Error, req: unknown, res: { headersSent?: boolean; writeHead?: (s: number) => void; end: () => void }) => void) => void }) =>
          proxy.on('error', (_err, _req, res) => { if (res.writeHead && !res.headersSent) { res.writeHead(502); res.end() } }),
      }])),
    },
  }
})
