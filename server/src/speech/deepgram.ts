// B: Deepgram Nova-3 provider (contract 3). Wire it up in ./index.ts createSpeechModule().
// Connect to wss://api.deepgram.com/v1/listen with model=nova-3, encoding=linear16,
// sample_rate=16000, channels=1, diarize=true, interim_results=true, endpointing=300.
// Send 20-100 ms per message (640-3,200 bytes). Use results marked final.
export {}
