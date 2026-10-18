const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="recorder-token"]')?.content;
const MAX_SECONDS = 120;
const Context = window.AudioContext || window.webkitAudioContext;
const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
let phase = 'idle';
let serverReady = false;
let operation = 0;
let capture = null;
let recordings = null;
let encoded = null;
let request = null;
let testHadError = false;
let receivedDone = false;
let counts = { utterances: 0, questions: 0, pairs: 0 };
const transcriptIds = new Set();
const questionIds = new Set();

function showError(message) {
  $('error-message').textContent = message;
  $('error-message').hidden = false;
}

function clearError() {
  $('error-message').hidden = true;
  $('error-message').textContent = '';
}

function recordingReady() {
  return recordings && recordings.total > 0;
}

function renderActions() {
  $('start').hidden = phase !== 'idle';
  $('start').disabled = !serverReady;
  $('stop-test').hidden = phase !== 'recording';
  $('retry').hidden = phase !== 'ready' || !recordingReady();
  $('retry').textContent = testHadError ? 'Retry test with this recording' : 'Test recording with ElevenLabs';
  $('record-again').hidden = !['ready', 'done'].includes(phase);
  $('cancel').hidden = ['idle', 'done'].includes(phase);
  $('check-connection').disabled = !['idle', 'ready', 'done'].includes(phase);
  const recording = phase === 'recording';
  $('recording-state').textContent = recording ? 'Recording' : phase === 'starting' ? 'Starting microphone' : 'Microphone off';
  $('recording-state').className = recording ? 'badge recording' : 'badge';
  $('capture-monitor').hidden = !recording;
}

async function checkConnection() {
  serverReady = false;
  $('connection-status').textContent = 'Checking the local server…';
  renderActions();
  try {
    if (!token || token === '__TOKEN__') throw new Error('Open the recorder through its local server so the page can connect securely.');
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !Context || !OfflineContext || !window.AudioWorkletNode) {
      throw new Error('Microphone recording needs a current Chrome or Edge browser at the local recorder address.');
    }
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (!response.ok) throw new Error(`The local server could not be reached (HTTP ${response.status}).`);
    const status = await response.json();
    if (!status.keyConfigured) throw new Error('Add the ElevenLabs key to server/.env, restart the local recorder, then check the connection again.');
    if (status.provider !== 'elevenlabs') throw new Error('The local recorder must be configured for ElevenLabs.');
    serverReady = true;
    $('connection-status').textContent = 'ElevenLabs key configured · Ready to record locally';
  } catch (error) {
    $('connection-status').textContent = error instanceof Error ? error.message : 'The local server is unavailable. Check that it is running.';
  }
  renderActions();
}

function updateMonitor() {
  const elapsed = recordings ? recordings.total / recordings.sampleRate : 0;
  $('elapsed').textContent = `${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, '0')}`;
}

function microphoneError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return 'Microphone access was blocked. Allow microphone access for this local page in your browser, then try again.';
  if (error?.name === 'NotFoundError') return 'No microphone was found. Connect or enable your laptop microphone, then try again.';
  if (error?.name === 'NotReadableError') return 'The microphone is unavailable. Close other apps using it, check your system microphone settings, then try again.';
  if (error?.name === 'OverconstrainedError') return 'This microphone could not use the requested settings. Try your laptop’s built-in microphone.';
  return 'The microphone could not start. Check the selected microphone and browser permission, then try again.';
}

async function stopCapture(flush = true) {
  const active = capture;
  if (!active) return;
  capture = null;
  clearInterval(active.timer);
  clearTimeout(active.limitTimer);
  if (active.node && flush) {
    let timeout;
    await Promise.race([
      new Promise((resolve) => {
        active.stopAck = resolve;
        active.node.port.postMessage({ type: 'stop' });
      }),
      new Promise((resolve) => { timeout = setTimeout(resolve, 250); }),
    ]);
    clearTimeout(timeout);
  }
  if (active.node) {
    active.node.port.onmessage = null;
    active.node.port.close();
    active.node.disconnect();
  }
  active.source?.disconnect();
  active.gain?.disconnect();
  for (const track of active.stream?.getTracks() || []) {
    track.onended = null;
    track.stop();
  }
  if (active.context.state !== 'closed') await active.context.close().catch(() => {});
  $('input-level').value = -60;
  updateMonitor();
}

async function limitReached(reason = 'limit') {
  if (phase !== 'recording') return;
  phase = 'preparing';
  renderActions();
  const expected = operation;
  await stopCapture();
  if (expected !== operation) return;
  phase = 'ready';
  $('recording-status').textContent = reason !== 'limit'
    ? 'Recording stopped and the microphone is off. You can test this recording or record again.'
    : 'The two-minute limit was reached. The microphone is off. Select Test recording to send the conversation to ElevenLabs.';
  renderActions();
}

async function startRecording() {
  if (phase !== 'idle' || !serverReady) return;
  clearError();
  const expected = ++operation;
  phase = 'starting';
  encoded = null;
  testHadError = false;
  $('recording-status').textContent = 'Allow microphone access when your browser asks.';
  renderActions();
  let active;
  try {
    const context = new Context();
    active = { context, stream: null, node: null, source: null, gain: null, timer: null, limitTimer: null, stopAck: null };
    capture = active;
    const sample = { sampleRate: context.sampleRate, chunks: [], total: 0 };
    recordings = sample;
    await context.resume();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, autoGainControl: false, echoCancellation: false, noiseSuppression: false }, video: false,
    });
    if (expected !== operation || capture !== active) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    active.stream = stream;
    await context.audioWorklet.addModule('/capture-worklet.js');
    if (expected !== operation || capture !== active) return;
    active.node = new AudioWorkletNode(context, 'pcm-capture', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
    });
    active.node.addEventListener('processorerror', () => {
      if (capture === active && phase === 'recording') {
        showError('Microphone capture stopped unexpectedly. Record again and keep this tab open.');
        void limitReached('processor');
      }
    });
    active.node.port.onmessage = ({ data }) => {
      if (data.type === 'stopped') { active.stopAck?.(); return; }
      if (expected !== operation || recordings !== sample) return;
      if (data.type === 'limit') { void limitReached(); return; }
      if (data.type !== 'samples' || data.stage !== 0 || !(data.samples instanceof Float32Array)) return;
      const remaining = Math.floor(sample.sampleRate * MAX_SECONDS) - sample.total;
      const samples = data.samples.length <= remaining ? data.samples : data.samples.slice(0, Math.max(0, remaining));
      if (!samples.length) return;
      sample.chunks.push(samples);
      sample.total += samples.length;
      let sum = 0;
      for (const value of samples) sum += value * value;
      const db = sum > 0 ? Math.max(-60, 10 * Math.log10(sum / samples.length)) : -60;
      $('input-level').value = db;
      $('level-label').textContent = db <= -59 ? 'Very quiet — speak normally' : `${Math.round(db)} dBFS${db > -3 ? ' · too loud; move back slightly' : ''}`;
    };
    active.source = context.createMediaStreamSource(stream);
    active.gain = context.createGain();
    active.gain.gain.value = 0;
    active.source.connect(active.node);
    active.node.connect(active.gain);
    active.gain.connect(context.destination);
    for (const track of stream.getAudioTracks()) track.onended = () => {
      if (capture === active && phase === 'recording') {
        showError('The microphone disconnected. Record again after reconnecting it.');
        void limitReached('disconnected');
      }
    };
    phase = 'recording';
    $('recording-status').textContent = 'Recording your conversation. Speak naturally, then select Stop & test.';
    active.timer = setInterval(updateMonitor, 250);
    active.limitTimer = setTimeout(() => { void limitReached(); }, MAX_SECONDS * 1000);
    renderActions();
    updateMonitor();
    $('stop-test').focus({ preventScroll: true });
  } catch (error) {
    if (expected !== operation) return;
    await stopCapture(false);
    if (expected !== operation) return;
    recordings = null;
    phase = 'idle';
    showError(microphoneError(error));
    $('recording-status').textContent = 'The microphone is off. You can try again.';
    renderActions();
  }
}

async function encodeRecording(chunks, originalRate) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const floats = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) { floats.set(chunk, offset); offset += chunk.length; }
  // Floor so resampling roundoff cannot exceed the exact 120-second limit.
  const outputLength = Math.max(1, Math.floor(length * 16000 / originalRate));
  const offline = new OfflineContext(1, outputLength, 16000);
  const buffer = offline.createBuffer(1, length, originalRate);
  buffer.copyToChannel(floats, 0);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  const channel = rendered.getChannelData(0);
  const pcm = new Uint8Array(channel.length * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < channel.length; i++) {
    const value = Math.max(-1, Math.min(1, channel[i]));
    view.setInt16(i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  let binary = '';
  for (let i = 0; i < pcm.length; i += 32768) binary += String.fromCharCode(...pcm.subarray(i, i + 32768));
  return btoa(binary);
}

function resetResults() {
  counts = { utterances: 0, questions: 0, pairs: 0 };
  transcriptIds.clear();
  questionIds.clear();
  receivedDone = false;
  testHadError = false;
  $('transcript').replaceChildren();
  $('pairs').replaceChildren();
  $('transcript-empty').hidden = false;
  for (const name of ['pairs-section', 'latency', 'saved-path']) $(name).hidden = true;
  $('test-progress').value = 0;
  $('test-progress').textContent = '0%';
  $('test-state').textContent = 'Preparing';
  $('test-state').className = 'badge';
  updateCounts();
}

function updateCounts() {
  $('utterance-count').textContent = counts.utterances;
  $('question-count').textContent = counts.questions;
  $('pair-count').textContent = counts.pairs;
  $('question-count-card').hidden = counts.questions === 0;
  $('pair-count-card').hidden = counts.pairs === 0;
}

function timeLabel(ms) {
  if (!Number.isFinite(ms)) return '';
  return `${(ms / 1000).toFixed(1)}s`;
}

function handleTestEvent(data) {
  if (!data || typeof data.event !== 'string') throw new Error('The local server returned an invalid test event.');
  if (data.event === 'progress') {
    if (Number.isFinite(data.percent)) {
      const percent = Math.max(0, Math.min(100, data.percent));
      $('test-progress').value = percent;
      $('test-progress').textContent = `${Math.round(percent)}%`;
      $('test-status').textContent = `Replaying your conversation to ElevenLabs · ${Math.round(percent)}% sent`;
    }
  } else if (data.event === 'utterance') {
    if (typeof data.text !== 'string') return;
    const id = data.id || `${data.startMs}:${data.endMs}:${data.text}`;
    if (transcriptIds.has(id)) return;
    transcriptIds.add(id);
    counts.utterances++;
    const item = document.createElement('li');
    const meta = document.createElement('div');
    meta.className = 'utterance-meta';
    const voice = data.identityKnown === true
      ? (typeof data.name === 'string' && data.name ? data.name : data.isWearer ? 'Wearer' : 'Other speaker')
      : 'Speaker not assigned';
    const rms = Number.isFinite(data.rmsDb) ? ` · ${data.rmsDb.toFixed(1)} dBFS` : '';
    meta.textContent = `${voice} · ${timeLabel(data.startMs)}–${timeLabel(data.endMs)}${rms}`;
    const text = document.createElement('p');
    text.className = 'utterance-text';
    text.textContent = data.text;
    item.append(meta, text);
    $('transcript').append(item);
    $('transcript-empty').hidden = true;
  } else if (data.event === 'question') {
    const id = data.id || `${data.startMs}:${data.text}`;
    if (!questionIds.has(id)) { questionIds.add(id); counts.questions++; }
  } else if (data.event === 'pair') {
    if (typeof data.question?.text !== 'string' || typeof data.answer?.text !== 'string') return;
    counts.pairs++;
    const card = document.createElement('div');
    card.className = 'pair';
    for (const [label, text] of [['Question: ', data.question.text], ['Answer: ', data.answer.text]]) {
      const line = document.createElement('p');
      const strong = document.createElement('strong');
      strong.textContent = label;
      line.append(strong, document.createTextNode(text));
      card.append(line);
    }
    $('pairs').append(card);
    $('pairs-section').hidden = false;
  } else if (data.event === 'latency' && Number.isFinite(data.transcriptMs)) {
    $('latency').hidden = false;
    $('latency').textContent = `Latest question: ${(data.transcriptMs / 1000).toFixed(2)} seconds from speech end to final transcript. Glasses delivery time is not measured here.`;
  } else if (data.event === 'error') {
    testHadError = true;
    showError(typeof data.message === 'string' ? data.message : 'The speech test could not finish.');
    $('test-status').textContent = 'The test reported a problem. You can retry using this recording.';
  } else if (data.event === 'done') {
    receivedDone = true;
    for (const name of ['utterances', 'questions', 'pairs']) if (Number.isFinite(data[name]) && data[name] >= 0) counts[name] = data[name];
    if (typeof data.savedTo === 'string' && data.savedTo) {
      $('saved-path').hidden = false;
      $('saved-path').textContent = `Saved on this laptop: ${data.savedTo}`;
    }
  }
  updateCounts();
}

async function runTest() {
  if (!['recording', 'ready'].includes(phase)) return;
  if (!recordingReady()) {
    showError('Record a little audio before testing.');
    return;
  }
  clearError();
  const previousOperation = operation;
  phase = 'preparing';
  renderActions();
  $('cancel').focus({ preventScroll: true });
  await stopCapture();
  if (previousOperation !== operation) return;
  const expected = ++operation;
  resetResults();
  $('results').hidden = false;
  $('test-status').textContent = 'Converting your recording to 16 kHz audio on this laptop…';
  $('recording-status').textContent = 'The microphone is off. Preparing your recording for the test.';
  const controller = new AbortController();
  request = controller;
  try {
    if (!encoded) {
      const conversationPcm = await encodeRecording(recordings.chunks, recordings.sampleRate);
      if (expected !== operation) return;
      encoded = { conversationPcm };
    }
    if (expected !== operation) return;
    phase = 'testing';
    renderActions();
    $('test-state').textContent = 'Testing';
    $('test-status').textContent = 'Sending your conversation to ElevenLabs for transcription…';
    $('recording-status').textContent = 'The microphone is off. Your recorded conversation is being tested.';
    const response = await fetch('/api/test', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-recorder-token': token },
      body: JSON.stringify(encoded), signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(typeof body?.error === 'string' ? body.error : `The test request failed (HTTP ${response.status}).`);
    }
    if (!response.body) throw new Error('This browser cannot read the live test results. Try a current Chrome or Edge browser.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (expected !== operation) { await reader.cancel(); return; }
      buffer += decoder.decode(value, { stream: !done });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) handleTestEvent(JSON.parse(line));
      }
      if (buffer.length > 1048576) throw new Error('The local server returned an unexpectedly large test event.');
      if (done) { if (buffer.trim()) handleTestEvent(JSON.parse(buffer)); break; }
    }
    if (!receivedDone && !testHadError) throw new Error('The test connection ended early. Retry using the same recording.');
    phase = testHadError ? 'ready' : 'done';
    $('test-state').textContent = testHadError ? 'Needs attention' : 'Complete';
    $('test-state').className = testHadError ? 'badge' : 'badge complete';
    if (!testHadError) {
      $('test-progress').value = 100;
      $('test-progress').textContent = '100%';
      $('test-status').textContent = `Test complete. Captured ${counts.utterances} ${counts.utterances === 1 ? 'utterance' : 'utterances'}.`;
    }
    $('recording-status').textContent = 'The microphone is off. Your transcript is below.';
  } catch (error) {
    if (expected !== operation || controller.signal.aborted) return;
    testHadError = true;
    phase = 'ready';
    showError(error instanceof SyntaxError ? 'The local server returned incomplete test data. Retry using the same recording.' : error instanceof Error ? error.message : 'The test could not finish. Retry using the same recording.');
    $('test-state').textContent = 'Needs attention';
    $('test-state').className = 'badge';
    $('test-status').textContent = 'The test stopped. Your recording is still available for a retry.';
    $('recording-status').textContent = 'The microphone is off. You can retry the test or record again.';
  } finally {
    if (expected === operation) {
      request = null;
      renderActions();
    }
  }
}

async function cancel() {
  const expected = ++operation;
  request?.abort();
  request = null;
  phase = 'idle';
  await stopCapture(false);
  if (expected !== operation) return;
  recordings = null;
  encoded = null;
  clearError();
  resetResults();
  $('results').hidden = true;
  $('recording-status').textContent = 'The microphone is off. Start again when you’re ready.';
  updateMonitor();
  renderActions();
}

$('start').addEventListener('click', () => { void startRecording(); });
$('stop-test').addEventListener('click', () => { void runTest(); });
$('retry').addEventListener('click', () => { void runTest(); });
$('cancel').addEventListener('click', () => { void cancel(); });
$('record-again').addEventListener('click', async () => { await cancel(); await startRecording(); });
$('check-connection').addEventListener('click', () => { void checkConnection(); });
window.addEventListener('pagehide', () => {
  operation++;
  request?.abort();
  // Stop tracks synchronously: unloading cannot wait for an audio-thread ack.
  for (const track of capture?.stream?.getTracks() || []) track.stop();
  void stopCapture(false);
});

void checkConnection();
