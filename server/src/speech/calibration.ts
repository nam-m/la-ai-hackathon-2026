import { pcmRmsDb } from './audio.js';

/** Parse a RIFF/WAVE recording without accepting implicit resampling or channel conversion. */
export function readPcmWav(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Expected a RIFF/WAVE file');
  const end = view.getUint32(4, true) + 8;
  if (end !== bytes.length) throw new Error('WAV RIFF size does not match file length');
  let formatFound = false;
  let pcm: Uint8Array | undefined;
  let offset = 12;
  while (offset < end) {
    if (offset + 8 > end) throw new Error('Truncated WAV chunk header');
    const kind = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const begin = offset + 8;
    if (begin + size + size % 2 > end) throw new Error('Truncated WAV chunk');
    if (kind === 'fmt ') {
      if (formatFound || size < 16) throw new Error('Invalid WAV format chunk');
      formatFound = true;
      if (view.getUint16(begin, true) !== 1 || view.getUint16(begin + 2, true) !== 1 || view.getUint32(begin + 4, true) !== 16_000 || view.getUint16(begin + 14, true) !== 16 || view.getUint16(begin + 12, true) !== 2 || view.getUint32(begin + 8, true) !== 32_000) throw new Error('WAV must be PCM signed 16-bit little-endian, 16 kHz, mono');
    } else if (kind === 'data') {
      if (pcm || !size || size % 2) throw new Error('WAV must contain one nonempty, sample-aligned data chunk');
      pcm = Uint8Array.from(bytes.subarray(begin, begin + size));
    }
    offset = begin + size + size % 2;
  }
  if (!formatFound || !pcm) throw new Error('WAV is missing format or audio data');
  return pcm;
}

export interface CalibrationRecording { label: 'wearer' | 'other'; pcm: Uint8Array; name?: string; }
export interface RmsDistribution { count: number; min: number; max: number; mean: number; p10: number; median: number; p90: number; }
export interface CalibrationResult {
  recommendedProvider: 'elevenlabs' | 'deepgram';
  clearGap: boolean;
  gapDb: number;
  thresholdDb: number | null;
  distributions: { wearer: RmsDistribution; other: RmsDistribution };
  sentences: { name: string; label: 'wearer' | 'other'; rmsDb: number; durationMs: number }[];
  providerOptions: { provider: 'elevenlabs' | 'deepgram'; wearerThresholdDb?: number };
}

function distribution(values: number[]): RmsDistribution {
  values.sort((a, b) => a - b);
  const quantile = (p: number) => {
    const index = (values.length - 1) * p;
    const lo = Math.floor(index);
    return values[lo]! + (values[Math.ceil(index)]! - values[lo]!) * (index - lo);
  };
  return { count: values.length, min: values[0]!, max: values[values.length - 1]!, mean: values.reduce((a, b) => a + b, 0) / values.length, p10: quantile(.1), median: quantile(.5), p90: quantile(.9) };
}

/** Each recording is one labeled sentence captured with the production microphone/gain. */
export function calibrateSpeech(recordings: CalibrationRecording[]): CalibrationResult {
  const sentences = recordings.map((recording, index) => {
    if (recording.label !== 'wearer' && recording.label !== 'other') throw new Error('Recording labels must be wearer or other');
    if (!recording.pcm.length || recording.pcm.length % 2) throw new Error('PCM recordings must contain complete signed 16-bit samples');
    const rmsDb = pcmRmsDb(recording.pcm);
    if (rmsDb <= -120) throw new Error('Calibration recordings must contain audible samples');
    return { name: recording.name ?? `sentence-${index + 1}`, label: recording.label, rmsDb, durationMs: recording.pcm.length / 32 };
  });
  const wearer = sentences.filter(s => s.label === 'wearer').map(s => s.rmsDb);
  const other = sentences.filter(s => s.label === 'other').map(s => s.rmsDb);
  if (!wearer.length || !other.length) throw new Error('Calibration requires wearer and other sentence recordings');
  const distributions = { wearer: distribution(wearer), other: distribution(other) };
  const gapDb = distributions.wearer.min - distributions.other.max;
  const clearGap = gapDb >= 6;
  const thresholdDb = clearGap ? (distributions.wearer.min + distributions.other.max) / 2 : null;
  const recommendedProvider = clearGap ? 'elevenlabs' : 'deepgram';
  return { recommendedProvider, clearGap, gapDb, thresholdDb, distributions, sentences, providerOptions: thresholdDb === null ? { provider: recommendedProvider } : { provider: recommendedProvider, wearerThresholdDb: thresholdDb } };
}
