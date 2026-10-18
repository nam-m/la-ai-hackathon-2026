import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSpeechModule } from '../src/speech/index.js';
import { speechOptionsFromEnv } from '../src/speech/config.js';
import { readPcmWav } from '../src/speech/calibration.js';

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path || process.argv.length > 3) throw new Error('Usage: npm run speech:replay -- recording.wav (or .pcm); this sends the recording to SPEECH_PROVIDER');
  const config = speechOptionsFromEnv();
  if (config.provider === 'fake') throw new Error('Use speech:demo for fake mode');
  if (config.provider === 'elevenlabs' && config.wearerThresholdDb === undefined) throw new Error('Set SPEECH_WEARER_THRESHOLD_DB from calibration before replay');
  const bytes = await readFile(path);
  const extension = extname(path).toLowerCase();
  if (extension !== '.wav' && extension !== '.pcm') throw new Error('Recording must be a .wav or .pcm file');
  const pcm = extension === '.wav' ? readPcmWav(bytes) : bytes;
  if (!pcm.length || pcm.length % 2) throw new Error('Recording must contain complete 16-bit PCM samples');
  let failure: Error | undefined;
  const speech = createSpeechModule({ ...config,
    onUtterance: utterance => console.log(JSON.stringify({ event: 'utterance', ...utterance })),
    onWearerQuestion: question => console.log(JSON.stringify({ event: 'question', id: question.id, text: question.text })),
    onPair: pair => console.log(JSON.stringify({ event: 'pair', ...pair })),
    onLatency: measurement => console.log(JSON.stringify({ event: 'latency', ...measurement })),
    onError: error => { failure = error; },
  });
  const cancel = () => { failure = new Error('Replay interrupted'); };
  process.once('SIGINT', cancel);
  try {
    console.log(`Replaying consented audio to ${config.provider}; transcript latency only (no glasses connected).`);
    for (let offset = 0; offset < pcm.length && !failure; offset += 1600) {
      speech.pushAudio(pcm.subarray(offset, offset + 1600));
      await delay(50);
    }
    // Real-time quiet audio permits the VAD to finalize the last sentence.
    for (let i = 0; i < 44 && !failure; i++) { speech.pushAudio(new Uint8Array(1600)); await delay(50); }
    await delay(1000);
    if (failure) throw failure;
  } finally { process.removeListener('SIGINT', cancel); await speech.close(); }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Replay failed'); process.exitCode = 1; });
