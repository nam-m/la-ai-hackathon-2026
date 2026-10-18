const SAMPLE_RATE = 16_000;
const BYTES_PER_MS = 32;
const FLOOR_DB = -120;

function sampleAt(pcm: Uint8Array, offset: number): number {
  const value = pcm[offset]! | (pcm[offset + 1]! << 8);
  return value >= 0x8000 ? value - 0x10000 : value;
}

function energyDb(energy: number, count: number): number {
  return count && energy > 0 ? Math.max(FLOOR_DB, 10 * Math.log10(energy / count / (32768 ** 2))) : FLOOR_DB;
}

/** RMS of complete signed 16-bit little-endian samples, relative to full scale. */
export function pcmRmsDb(pcm: Uint8Array): number {
  let energy = 0;
  const count = Math.floor(pcm.length / 2);
  for (let i = 0; i < count * 2; i += 2) energy += sampleAt(pcm, i) ** 2;
  return energyDb(energy, count);
}

export interface AudioPipelineOptions {
  onFrame(frame: Uint8Array): void;
  silenceThresholdDb?: number;
  hangoverMs?: number;
  frameMs?: number;
  startMs?: number;
}

interface Frame { pcm: Uint8Array; sourceStart: number; }
interface SentFrame extends Frame { sentStart: number; sentEnd: number; }

/** Input and source clocks include silence; the provider clock includes only emitted PCM. */
export class AudioPipeline {
  private readonly frameBytes: number;
  private readonly threshold: number;
  private readonly hangoverMs: number;
  private readonly baseMs: number;
  private pending = new Uint8Array(0);
  private consumedSamples = 0;
  private inputBytes = 0;
  private sentSamples = 0;
  private lastSpeechEnd = -Infinity;
  private preroll: Frame[] = [];
  private retained: SentFrame[] = [];

  constructor(private readonly options: AudioPipelineOptions) {
    const frameMs = options.frameMs ?? 50;
    this.threshold = options.silenceThresholdDb ?? -50;
    this.hangoverMs = options.hangoverMs ?? 2000;
    this.baseMs = options.startMs ?? 0;
    if (!Number.isFinite(frameMs) || frameMs <= 0 || !Number.isInteger(frameMs * SAMPLE_RATE / 1000)) throw new Error('frameMs must describe a positive whole number of samples');
    if (!Number.isFinite(this.threshold) || !Number.isFinite(this.hangoverMs) || this.hangoverMs < 0 || !Number.isFinite(this.baseMs) || this.baseMs < 0) throw new Error('Invalid audio pipeline options');
    this.frameBytes = frameMs * BYTES_PER_MS;
  }

  get receivedMs(): number { return Math.floor(this.inputBytes / 2) * 1000 / SAMPLE_RATE; }

  push(pcm: Uint8Array): void {
    this.inputBytes += pcm.length;
    const joined = new Uint8Array(this.pending.length + pcm.length);
    joined.set(this.pending);
    joined.set(pcm, this.pending.length);
    let offset = 0;
    while (offset + this.frameBytes <= joined.length) {
      this.process(joined.slice(offset, offset + this.frameBytes));
      offset += this.frameBytes;
    }
    this.pending = joined.slice(offset);
  }

  flush(): void {
    const completeBytes = this.pending.length - this.pending.length % 2;
    if (completeBytes) this.process(this.pending.slice(0, completeBytes));
    this.pending = this.pending.slice(completeBytes);
  }

  reset(): void {
    this.pending = new Uint8Array(0);
    this.consumedSamples = this.inputBytes = this.sentSamples = 0;
    this.lastSpeechEnd = -Infinity;
    this.preroll = [];
    this.retained = [];
  }

  private process(pcm: Uint8Array): void {
    const sourceStart = this.baseMs + this.consumedSamples * 1000 / SAMPLE_RATE;
    const duration = pcm.length / BYTES_PER_MS;
    this.consumedSamples += pcm.length / 2;
    const frame = { pcm, sourceStart };
    const speech = pcmRmsDb(pcm) >= this.threshold;
    if (speech) {
      for (const previous of this.preroll) this.emit(previous);
      this.preroll = [];
      this.lastSpeechEnd = sourceStart + duration;
      this.emit(frame);
    } else if (sourceStart < this.lastSpeechEnd + this.hangoverMs) {
      this.emit(frame);
    } else {
      this.preroll.push(frame);
      const cutoff = sourceStart + duration - 100;
      while (this.preroll.length && this.preroll[0]!.sourceStart + this.preroll[0]!.pcm.length / BYTES_PER_MS <= cutoff) this.preroll.shift();
    }
  }

  private emit(frame: Frame): void {
    const sentStart = this.sentSamples * 1000 / SAMPLE_RATE;
    this.sentSamples += frame.pcm.length / 2;
    const sentEnd = this.sentSamples * 1000 / SAMPLE_RATE;
    this.retained.push({ ...frame, sentStart, sentEnd });
    const cutoff = sentEnd - 120_000;
    while (this.retained.length && this.retained[0]!.sentEnd <= cutoff) this.retained.shift();
    this.options.onFrame(frame.pcm.slice());
  }

  /** Map a provider interval in milliseconds back to the original recording. */
  mapRange(startMs: number, endMs: number): { startMs: number; endMs: number; rmsDb: number } | null {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || !this.retained.length) return null;
    if (startMs < this.retained[0]!.sentStart || endMs > this.sentSamples * 1000 / SAMPLE_RATE) return null;
    let sourceStart: number | undefined;
    let sourceEnd = 0;
    let energy = 0;
    let count = 0;
    for (const frame of this.retained) {
      const lo = Math.max(startMs, frame.sentStart);
      const hi = Math.min(endMs, frame.sentEnd);
      if (hi <= lo) continue;
      sourceStart ??= frame.sourceStart + lo - frame.sentStart;
      sourceEnd = frame.sourceStart + hi - frame.sentStart;
      const first = Math.floor((lo - frame.sentStart) * 16 + 1e-8);
      const last = Math.min(frame.pcm.length / 2, Math.ceil((hi - frame.sentStart) * 16 - 1e-8));
      for (let i = first; i < last; i++) { energy += sampleAt(frame.pcm, i * 2) ** 2; count++; }
    }
    return sourceStart === undefined ? null : { startMs: sourceStart, endMs: sourceEnd, rmsDb: energyDb(energy, count) };
  }
}
