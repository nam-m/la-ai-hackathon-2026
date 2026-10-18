import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function capture(sampleRate = 16000) {
  let Processor: any;
  const messages: any[] = [];
  const source = readFileSync(new URL('../scripts/recorder-web/capture-worklet.js', import.meta.url), 'utf8');
  runInNewContext(source, {
    sampleRate, Float32Array,
    AudioWorkletProcessor: class {
      port = { onmessage: undefined, postMessage: (message: unknown) => messages.push(message) };
    },
    registerProcessor: (_name: string, implementation: any) => { Processor = implementation; },
  });
  return { processor: new Processor(), messages };
}

test('recorder worklet preserves samples, tags stage before switching, and silences output', () => {
  const { processor, messages } = capture();
  const output = new Float32Array(128).fill(1);
  processor.process([[new Float32Array(128).fill(.25)]], [[output]]);
  assert.equal(output.every(value => value === 0), true);
  processor.port.onmessage({ data: { type: 'stage', stage: 1 } });
  assert.equal(messages[0].stage, 0);
  assert.equal(messages[0].samples.length, 128);
  assert.equal(messages[0].samples[0], .25);
  processor.process([[new Float32Array(128).fill(.125)]], [[output]]);
  processor.port.onmessage({ data: { type: 'stop' } });
  const samples = messages.filter(message => message.type === 'samples');
  assert.equal(samples[1].stage, 1);
  assert.equal(samples[1].samples[0], .125);
  assert.equal(messages.at(-1).type, 'stopped');
  const messageCount = messages.length;
  processor.process([[new Float32Array(128)]], [[output]]);
  assert.equal(messages.length, messageCount);
});

test('worklet enforces two minute sample limit without retaining excess input', () => {
  const { processor, messages } = capture(10);
  processor.process([[new Float32Array(1400).fill(.1)]], [[new Float32Array(1400)]]);
  assert.equal(messages[0].samples.length, 1200);
  assert.equal(messages[1].type, 'limit');
  assert.equal(processor.active, false);
});
