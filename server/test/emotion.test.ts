import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

// A stand-in tone service that can be stopped and restarted on the same port.
let toneServer: http.Server | undefined;
async function startTone(port = 0): Promise<number> {
  toneServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/health' ? { ok: true, model: 'test', mock: false, loaded: true } : { detail: 'unused' }));
  });
  await new Promise<void>(done => toneServer!.listen(port, '127.0.0.1', done));
  return (toneServer.address() as AddressInfo).port;
}
const stopTone = () => new Promise<void>(done => { toneServer!.closeAllConnections(); toneServer!.close(() => done()); });

// Dynamic imports keep the real store, dotenv and tone URL isolated from developer data/keys.
const directory = await mkdtemp(join(tmpdir(), 'emotion-tests-'));
const port = await startTone();
process.env.DOTENV_CONFIG_PATH = join(directory, 'no-env-file');
process.env.DATA_FILE = join(directory, 'store.json');
process.env.TONE_URL = `http://127.0.0.1:${port}`;
const emotion = await import('../src/emotion/index.js');
const store = await import('../src/store.js');
after(async () => { store.flush(); if (toneServer?.listening) await stopTone(); await rm(directory, { recursive: true, force: true }); });

// 1.5 s of loud audio, so the question isn't skipped as too short or too quiet.
const loud = () => { const pcm = new Uint8Array(48_000); const view = new DataView(pcm.buffer); for (let i = 0; i < 24_000; i++) view.setInt16(i * 2, i % 2 ? 8000 : -8000, true); return pcm; };

test('health checks alone show an outage and a recovery, with no questions', async () => {
  assert.equal(emotion.toneStatus().state, 'not reached yet');
  assert.equal(await emotion.probe(), true);
  assert.equal(emotion.toneStatus().state, 'on');

  await stopTone();
  assert.equal(await emotion.probe(), false);
  assert.equal(emotion.toneStatus().state, 'degraded');
  await emotion.probe(); await emotion.probe(); // 3 failed checks open the breaker
  assert.equal(emotion.toneStatus().state, 'unreachable');

  await startTone(port);
  assert.equal(await emotion.probe(), true);
  assert.equal(emotion.toneStatus().state, 'on');
});

test('a failed tone call while the service is down is recovered by the next health check', async () => {
  await stopTone();
  await emotion.analyzeQuestion('qe_outage', loud());
  assert.equal(emotion.toneStatus().state, 'degraded');
  await startTone(port);
  assert.equal(await emotion.probe(), true);
  assert.equal(emotion.toneStatus().state, 'on');
});

test('tone off reports off', () => {
  store.setSettings({ toneAnalysis: false });
  try { assert.equal(emotion.toneStatus().state, 'off'); assert.equal(emotion.toneEnabled(), false); }
  finally { store.setSettings({ toneAnalysis: true }); }
});
