import type { SpeechOptions } from './index.js';

/** Server-only configuration: never import this into the glasses app. */
export function speechOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): Pick<SpeechOptions, 'provider' | 'apiKey' | 'wearerThresholdDb' | 'wearerMarginDb' | 'silenceThresholdDb' | 'wearerSpeaker' | 'speakerNames'> {
  const provider = env.SPEECH_PROVIDER?.trim() || 'elevenlabs';
  if (provider !== 'elevenlabs' && provider !== 'deepgram' && provider !== 'fake') throw new Error('SPEECH_PROVIDER must be elevenlabs, deepgram, or fake');
  function db(name: string): number | undefined {
    const raw = env[name];
    if (raw === undefined || !raw.trim()) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < -120 || value > 0) throw new Error(`${name} must be a dBFS number from -120 to 0`);
    return value;
  }
  let speakerNames: Record<string, string> | undefined;
  if (env.SPEECH_SPEAKER_NAMES) {
    let value: unknown;
    try { value = JSON.parse(env.SPEECH_SPEAKER_NAMES); } catch { throw new Error('SPEECH_SPEAKER_NAMES must be a JSON object of label-to-name mappings'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.values(value).every(name => typeof name === 'string')) throw new Error('SPEECH_SPEAKER_NAMES must map labels to names');
    speakerNames = value as Record<string, string>;
  }
  const marginRaw = env.SPEECH_WEARER_MARGIN_DB?.trim();
  const wearerMarginDb = marginRaw ? Number(marginRaw) : undefined;
  if (wearerMarginDb !== undefined && (!Number.isFinite(wearerMarginDb) || wearerMarginDb < 0 || wearerMarginDb > 120)) {
    throw new Error('SPEECH_WEARER_MARGIN_DB must be a dB margin from 0 to 120');
  }
  return {
    provider,
    apiKey: provider === 'fake' ? '' : (env.SPEECH_API_KEY?.trim() ||
      (provider === 'elevenlabs' ? env.ELEVENLABS_API_KEY?.trim() : env.DEEPGRAM_API_KEY?.trim()) || ''),
    wearerThresholdDb: db('SPEECH_WEARER_THRESHOLD_DB'),
    wearerMarginDb,
    silenceThresholdDb: db('SPEECH_SILENCE_THRESHOLD_DB'),
    wearerSpeaker: env.SPEECH_WEARER_SPEAKER || undefined,
    speakerNames,
  };
}
