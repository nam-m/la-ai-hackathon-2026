import { setTimeout as delay } from 'node:timers/promises';
import { createSpeechModule } from '../src/speech/index.js';

let questions = 0;
let pairs = 0;
const speech = createSpeechModule({
  provider: 'fake', apiKey: '',
  onUtterance: u => console.log(JSON.stringify({ event: 'utterance', ...u })),
  onWearerQuestion: question => { questions++; console.log(JSON.stringify({ event: 'question', text: question.text })); },
  onPair: pair => { pairs++; console.log(JSON.stringify({ event: 'pair', question: pair.question.text, answer: pair.answer.text, name: pair.answer.name })); },
  onError: error => { console.error(error.message); process.exitCode = 1; },
});
try {
  await delay(3500);
  if (questions !== 2 || pairs !== 2) throw new Error(`Demo failed: got ${questions} questions and ${pairs} pairs`);
  console.log('Speech demo passed: 2 wearer questions, 2 verbatim Q&A pairs. No API calls.');
} finally { await speech.close(); }
