export type SpeakerRole = 'wearer' | 'other' | 'unknown';

export type Utterance = {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  rmsDb: number;
  speaker: string | null;
  name: string | null;
  role: SpeakerRole;
  /** Compatibility field; always exactly role === 'wearer'. */
  isWearer: boolean;
};

export type QAPair = { question: Utterance; answer: Utterance };

export interface SpeechModule {
  pushAudio(pcm: Uint8Array): void;
  pause(): void;
  resume(): void;
  close(): Promise<void>;
}

/** Provider times are milliseconds of PCM actually sent on this connection. */
export type ProviderUtterance = {
  text: string;
  startMs: number;
  endMs: number;
  speaker: string | null;
  /** Provider detected overlap or speaker metadata that cannot be attributed safely. */
  uncertain?: boolean;
};

export interface SpeechProvider {
  sendAudio(pcm: Uint8Array): void;
  close(): Promise<void>;
}

export type ProviderOptions = {
  apiKey: string;
  onUtterance(utterance: ProviderUtterance): void;
  onError(error: Error): void;
};

export type ProviderFactory = (options: ProviderOptions) => SpeechProvider;
