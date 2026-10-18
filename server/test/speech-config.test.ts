import assert from 'node:assert/strict';
import { test } from 'node:test';
import { speechOptionsFromEnv } from '../src/speech/config.js';

test('speech config defaults missing or blank provider to ElevenLabs and rejects unknown providers', () => {
  for (const provider of [undefined, '', '   ']) {
    assert.equal(speechOptionsFromEnv({ SPEECH_PROVIDER: provider }).provider, 'elevenlabs');
  }
  assert.equal(speechOptionsFromEnv({ SPEECH_PROVIDER: ' deepgram ' }).provider, 'deepgram');
  for (const provider of ['other', 'ElevenLabs', '0']) {
    assert.throws(() => speechOptionsFromEnv({ SPEECH_PROVIDER: provider }), /SPEECH_PROVIDER/);
  }
});

for (const provider of ['elevenlabs', 'deepgram'] as const) {
  test(`${provider} uses nonempty generic speech key before its provider alias`, () => {
    const options = speechOptionsFromEnv({ SPEECH_PROVIDER: provider, SPEECH_API_KEY: ' generic-test-key ',
      ELEVENLABS_API_KEY: ' eleven-test-key ', DEEPGRAM_API_KEY: ' deep-test-key ' });
    assert.equal(options.apiKey, 'generic-test-key');
    for (const generic of [undefined, '', '   ']) {
      const fallback = speechOptionsFromEnv({ SPEECH_PROVIDER: provider, SPEECH_API_KEY: generic,
        ELEVENLABS_API_KEY: ' eleven-test-key ', DEEPGRAM_API_KEY: ' deep-test-key ' });
      assert.equal(fallback.apiKey, provider === 'elevenlabs' ? 'eleven-test-key' : 'deep-test-key');
    }
    const unrelatedAlias = provider === 'elevenlabs' ? { DEEPGRAM_API_KEY: 'other-test-key' } : { ELEVENLABS_API_KEY: 'other-test-key' };
    assert.equal(speechOptionsFromEnv({ SPEECH_PROVIDER: provider, ...unrelatedAlias }).apiKey, '');
  });
}

test('fake speech never receives a generic or provider API key', () => {
  const options = speechOptionsFromEnv({ SPEECH_PROVIDER: 'fake', SPEECH_API_KEY: 'generic-test-key',
    ELEVENLABS_API_KEY: 'eleven-test-key', DEEPGRAM_API_KEY: 'deep-test-key' });
  assert.equal(options.provider, 'fake');
  assert.equal(options.apiKey, '');
});

test('blank numeric settings remain unspecified rather than becoming zero', () => {
  for (const value of [undefined, '', ' \t ']) {
    const options = speechOptionsFromEnv({ SPEECH_WEARER_THRESHOLD_DB: value, SPEECH_WEARER_MARGIN_DB: value,
      SPEECH_SILENCE_THRESHOLD_DB: value });
    assert.equal(options.wearerThresholdDb, undefined);
    assert.equal(options.wearerMarginDb, undefined);
    assert.equal(options.silenceThresholdDb, undefined);
  }
});

test('threshold settings accept finite dBFS boundaries and reject out-of-range or invalid values', () => {
  for (const key of ['SPEECH_WEARER_THRESHOLD_DB', 'SPEECH_SILENCE_THRESHOLD_DB'] as const) {
    const outputKey = key === 'SPEECH_WEARER_THRESHOLD_DB' ? 'wearerThresholdDb' : 'silenceThresholdDb';
    for (const value of [-120, -25.5, 0]) {
      assert.equal(speechOptionsFromEnv({ [key]: ` ${value} ` })[outputKey], value);
    }
    for (const value of ['-120.01', '0.01', 'NaN', 'Infinity', '-Infinity', 'loud']) {
      assert.throws(() => speechOptionsFromEnv({ [key]: value }), new RegExp(key));
    }
  }
});

test('wearer margin accepts finite 0..120 dB values and rejects invalid margins', () => {
  for (const margin of [0, 3, 2.5, 120]) {
    assert.equal(speechOptionsFromEnv({ SPEECH_WEARER_MARGIN_DB: ` ${margin} ` }).wearerMarginDb, margin);
  }
  for (const margin of ['-0.01', '120.01', 'NaN', 'Infinity', '-Infinity', 'unsure']) {
    assert.throws(() => speechOptionsFromEnv({ SPEECH_WEARER_MARGIN_DB: margin }), /SPEECH_WEARER_MARGIN_DB/);
  }
});
