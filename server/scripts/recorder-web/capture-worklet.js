// Runs on the audio rendering thread. Samples are transferred to the page;
// outputs are always silent, so the microphone never feeds the speakers.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.stage = 0;
    this.active = true;
    this.samples = new Float32Array(2048);
    this.used = 0;
    this.captured = 0;
    this.limit = Math.floor(sampleRate * 120);
    this.port.onmessage = ({ data }) => {
      if (data.type === 'stage') {
        this.flush();
        this.stage = data.stage;
        this.port.postMessage({ type: 'stage_changed', stage: this.stage });
      } else if (data.type === 'stop') {
        this.active = false;
        this.flush();
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }

  flush() {
    if (!this.used) return;
    const samples = this.samples.slice(0, this.used);
    this.port.postMessage({ type: 'samples', stage: this.stage, samples }, [samples.buffer]);
    this.used = 0;
  }

  process(inputs, outputs) {
    for (const output of outputs) for (const channel of output) channel.fill(0);
    const input = inputs[0]?.[0];
    if (!this.active || !input) return true;
    for (let i = 0; i < input.length && this.captured < this.limit; i++) {
      this.samples[this.used++] = input[i];
      this.captured++;
      if (this.used === this.samples.length) this.flush();
    }
    if (this.captured >= this.limit) {
      this.active = false;
      this.flush();
      this.port.postMessage({ type: 'limit' });
    }
    return true;
  }
}

registerProcessor('pcm-capture', CaptureProcessor);
