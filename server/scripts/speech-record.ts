import { resolve } from 'node:path';
import { createRecorderServer } from './recorder-server.js';

const port = Number(process.env.SPEECH_RECORDER_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('SPEECH_RECORDER_PORT must be a port from 1024 to 65535');
const { server } = createRecorderServer({ apiKey: process.env.ELEVENLABS_API_KEY ?? '', dataRoot: resolve('data/device-tests') });
server.on('error', error => { console.error(`Could not start the local recorder: ${error.message}`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(`Speech recorder ready: http://127.0.0.1:${port}`);
  console.log('Open in Chrome or Edge, click Start, and follow the recording prompts.');
  console.log(`ElevenLabs key ${process.env.ELEVENLABS_API_KEY?.trim() ? 'configured' : 'missing; add it to server/.env and restart'}.`);
});
