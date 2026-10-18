import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSpeechModule } from '../src/speech/index.js';
import { decodeRecording, pcmToWav } from '../src/speech/recording.js';

export interface RecorderServerOptions {
  apiKey: string;
  dataRoot: string;
  createSpeech?: typeof createSpeechModule;
  wait?: (ms: number) => Promise<void>;
}

const assets: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/capture-worklet.js': ['capture-worklet.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 6 * 1024 * 1024) throw new Error('Recording is too large. Keep the complete session under two minutes.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('The recording upload was incomplete. Please try again.'); }
}

/** Local-only test harness, independent of C's production server and phone protocol. */
export function createRecorderServer(options: RecorderServerOptions) {
  const token = randomUUID();
  let busy = false;
  const wait = options.wait ?? delay;
  const makeSpeech = options.createSpeech ?? createSpeechModule;
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'The local recorder encountered an unexpected error.' });
      else if (!res.writableEnded) res.end();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;

  function json(res: ServerResponse, status: number, body: object): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'");
    res.setHeader('Permissions-Policy', 'microphone=(self)');
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : 8787;
    const host = req.headers.host;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!host || !hosts.includes(host)) { json(res, 403, { error: 'Open this recorder using its localhost address.' }); return; }
    const path = new URL(req.url ?? '/', `http://${host}`).pathname;
    if (req.method === 'GET' && path === '/api/status') {
      json(res, 200, { keyConfigured: Boolean(options.apiKey.trim()), provider: 'elevenlabs' }); return;
    }
    if (req.method === 'GET' && assets[path]) {
      try {
        const [filename, contentType] = assets[path]!;
        let content = await readFile(new URL(`./recorder-web/${filename}`, import.meta.url), 'utf8');
        if (filename === 'index.html') content = content.replaceAll('__TOKEN__', token);
        res.writeHead(200, { 'Content-Type': contentType }); res.end(content);
      } catch { json(res, 404, { error: 'Recorder page is not available.' }); }
      return;
    }
    if (path !== '/api/test' || req.method !== 'POST') { json(res, 404, { error: 'Not found' }); return; }
    const origin = req.headers.origin;
    if (req.headers['x-recorder-token'] !== token || (origin && origin !== `http://${host}`)) {
      json(res, 403, { error: 'Reload the recorder page and try again.' }); return;
    }
    if (!req.headers['content-type']?.startsWith('application/json')) { json(res, 415, { error: 'Expected a JSON recording upload.' }); return; }
    if (!options.apiKey.trim()) { json(res, 503, { error: 'Add ELEVENLABS_API_KEY to server/.env, then restart the recorder.' }); return; }
    if (busy) { json(res, 409, { error: 'A recording is already being tested. Wait for it to finish or cancel it.' }); return; }
    busy = true;
    let speech: ReturnType<typeof createSpeechModule> | undefined;
    let disconnected = false;
    res.on('close', () => { disconnected = true; void speech?.close().catch(() => undefined); });
    const emit = (event: object) => { if (!disconnected) res.write(JSON.stringify(event) + '\n'); };
    try {
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected a microphone recording.');
      const fields = body as Record<string, unknown>;
      if (typeof fields.conversationPcm !== 'string') throw new Error('Record a conversation first.');
      const conversation = decodeRecording(fields.conversationPcm as string);
      if (conversation.length < 32000) throw new Error('Record at least one second of conversation.');
      const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
      const outputDir = join(options.dataRoot, runId);
      await mkdir(outputDir, { recursive: true });
      await writeFile(join(outputDir, 'conversation.wav'), pcmToWav(conversation));
      if (disconnected) return;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
      let failure: Error | undefined;
      let utterances = 0;
      let questions = 0;
      let pairs = 0;
      const events: object[] = [];
      const record = (event: object) => { events.push(event); emit(event); };
      // This transcription-only harness has no real-G2 calibration. All live
      // roles remain unknown; C's normal server passes calibrated settings.
      speech = makeSpeech({ provider: 'elevenlabs', apiKey: options.apiKey,
        onUtterance(u) { utterances++; record({ event: 'utterance', ...u, identityKnown: false }); },
        onWearerQuestion(q) { questions++; record({ event: 'question', ...q }); },
        onPair(pair) { pairs++; record({ event: 'pair', ...pair }); },
        onLatency(measurement) { record({ event: 'latency', ...measurement }); },
        onError(error) { failure = error; },
      });
      const started = performance.now();
      // Schedule against an absolute target to avoid accumulating timer drift.
      for (let offset = 0; offset < conversation.length && !failure && !disconnected; offset += 1600) {
        speech.pushAudio(conversation.subarray(offset, offset + 1600));
        if (offset % 16000 === 0) emit({ event: 'progress', percent: Math.floor(offset / conversation.length * 100) });
        await wait(Math.max(0, started + (offset + 1600) / 32 - performance.now()));
      }
      for (let i = 0; i < 44 && !failure && !disconnected; i++) { speech.pushAudio(new Uint8Array(1600)); await wait(50); }
      if (!failure && !disconnected) await wait(1500);
      if (disconnected) return;
      await writeFile(join(outputDir, 'results.json'), JSON.stringify({ utterances, questions, pairs, events }, null, 2));
      if (failure) throw failure;
      emit({ event: 'progress', percent: 100 });
      emit({ event: 'done', utterances, questions, pairs, savedTo: `server/data/device-tests/${runId}` });
    } catch (error) {
      // Providers already sanitize errors; ensure even a future exception cannot
      // accidentally echo this session's credential into the browser or logs.
      const raw = error instanceof Error ? error.message : 'The recording test failed.';
      const message = options.apiKey ? raw.split(options.apiKey).join('[redacted]') : raw;
      if (!disconnected) {
        if (res.headersSent) emit({ event: 'error', message });
        else json(res, 400, { error: message });
      }
    } finally {
      await speech?.close().catch(() => undefined);
      busy = false;
      if (!res.writableEnded && !disconnected) res.end();
    }
  }
  return { server, token };
}
