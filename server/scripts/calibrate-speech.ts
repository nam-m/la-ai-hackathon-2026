import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { calibrateSpeech, readPcmWav, type CalibrationRecording } from '../src/speech/calibration.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let manifestPath: string | undefined;
  let outputPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--manifest') manifestPath = args[++i];
    else if (arg === '--output' || arg === '--out') outputPath = args[++i];
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (!manifestPath) manifestPath = arg;
    else if (!outputPath) outputPath = arg;
    else throw new Error('Too many arguments');
  }
  if (!manifestPath || !outputPath) throw new Error('Usage: npm run speech:calibrate -- --manifest recordings.json --output calibration.json');
  const absoluteManifest = resolve(manifestPath);
  const manifest: unknown = JSON.parse(await readFile(absoluteManifest, 'utf8'));
  const entries = Array.isArray(manifest) ? manifest : (manifest as { recordings?: unknown } | null)?.recordings;
  if (!Array.isArray(entries)) throw new Error('Manifest must contain a recordings array');
  const recordings: CalibrationRecording[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || (entry.label !== 'wearer' && entry.label !== 'other') || typeof entry.path !== 'string') throw new Error('Each recording needs label (wearer/other) and path');
    const filePath = resolve(dirname(absoluteManifest), entry.path);
    const format = entry.format ?? extname(filePath).slice(1).toLowerCase();
    if (format !== 'pcm' && format !== 'wav') throw new Error(`Unsupported recording format: ${format}`);
    const bytes = await readFile(filePath);
    recordings.push({ label: entry.label, name: entry.name ?? entry.path, pcm: format === 'wav' ? readPcmWav(bytes) : bytes });
  }
  const result = calibrateSpeech(recordings);
  const absoluteOutput = resolve(outputPath);
  await mkdir(dirname(absoluteOutput), { recursive: true });
  await writeFile(absoluteOutput, JSON.stringify(result, null, 2) + '\n');
  console.log(`Recommended provider: ${result.recommendedProvider}; gap: ${result.gapDb.toFixed(2)} dB; saved ${absoluteOutput}`);
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
