import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv, type Plugin } from 'vite'

const RECORDINGS_DIR = fileURLToPath(new URL('./dev/recordings', import.meta.url))
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [recordingsUpload()],
    server: {
      host: true,
      port: 5173,
      // The app talks to same-origin /ws in dev; this forwards it to the mock
      // or, with WS_TARGET set, to C's server. WS_TARGET is an origin, no path.
      proxy: {
        '/ws': { target: env.WS_TARGET || 'ws://localhost:8787', ws: true, changeOrigin: true },
      },
    },
    build: { target: 'esnext' },
  }
})

// Dev-only endpoint for the phone's debug recorder: POST /dev/recordings/<name>.wav|.json
// writes the body to dev/recordings/ on the laptop.
function recordingsUpload(): Plugin {
  return {
    name: 'rewind-recordings',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/dev/recordings', (req, res) => {
        const name = path.basename(decodeURIComponent((req.url ?? '').split('?')[0]))
        if (req.method !== 'POST' || !/^[\w.-]+\.(wav|json)$/.test(name)) {
          res.statusCode = 400
          res.end('POST /dev/recordings/<name>.wav or .json')
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        req.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_UPLOAD_BYTES) req.destroy()
          else chunks.push(chunk)
        })
        req.on('end', async () => {
          try {
            await mkdir(RECORDINGS_DIR, { recursive: true })
            await writeFile(path.join(RECORDINGS_DIR, name), Buffer.concat(chunks))
            server.config.logger.info(`[recordings] saved dev/recordings/${name} (${size} bytes)`)
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ saved: `dev/recordings/${name}` }))
          } catch (err) {
            res.statusCode = 500
            res.end(String(err))
          }
        })
      })
    },
  }
}
