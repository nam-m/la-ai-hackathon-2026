const BYTES_PER_MS = 32;

function requirePcm(pcm: Uint8Array): void {
  if (!(pcm instanceof Uint8Array) || !pcm.byteLength || pcm.byteLength % 2) {
    throw new Error('Recording must contain nonempty, complete signed 16-bit PCM samples');
  }
}

/** Accept canonical, padded standard base64 containing raw 16 kHz mono signed16 PCM. */
export function decodeRecording(base64: string, maxMs = 120_000): Uint8Array {
  if (!Number.isFinite(maxMs) || maxMs <= 0 || maxMs > Number.MAX_SAFE_INTEGER / BYTES_PER_MS) {
    throw new Error('Maximum recording duration must be a positive finite number');
  }
  const maxBytes = Math.floor(maxMs * BYTES_PER_MS / 2) * 2;
  const maxEncodedLength = Math.ceil(maxBytes / 3) * 4;
  // Reject oversized strings before decoding or scanning their contents.
  if (typeof base64 !== 'string' || !base64.length) throw new Error('Recording base64 must be nonempty');
  if (base64.length > maxEncodedLength) throw new Error('Recording exceeds maximum duration');
  if (base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('Recording must use canonical base64');
  const pcm = Buffer.from(base64, 'base64');
  if (pcm.toString('base64') !== base64) throw new Error('Recording must use canonical base64');
  if (pcm.length > maxBytes) throw new Error('Recording exceeds maximum duration');
  requirePcm(pcm);
  return pcm;
}

/** Package raw PCM without resampling, normalization, or silence trimming. */
export function pcmToWav(pcm: Uint8Array): Buffer {
  requirePcm(pcm);
  if (pcm.length > 0xffff_ffff - 36) throw new Error('Recording is too large for RIFF/WAVE');
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40);
  wav.set(pcm, 44);
  return wav;
}
