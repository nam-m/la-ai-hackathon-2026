import { readFileSync } from 'node:fs';
import type { SpeakerRole, Utterance } from './types.js';

export type FakeLine = Pick<Utterance, 'text' | 'startMs' | 'endMs' | 'isWearer' | 'name'> & { role?: SpeakerRole };

/** Main format: delaySeconds | wearer/Name/unknown | text. Legacy TSV remains supported. */
export function readFakeScript(path?: string): FakeLine[] {
  const input = readFileSync(path ?? new URL('../../scripts/fake-script.txt', import.meta.url), 'utf8');
  let previous = 0;
  return input.split(/\r?\n/).map((line, index) => ({ line, index })).filter(({ line }) => line.trim() && !line.trimStart().startsWith('#')).map(({ line, index }) => {
    let endMs: number;
    let role: SpeakerRole;
    let name: string | null;
    let text: string;
    if (line.includes('\t')) {
      const [end, label, person, ...words] = line.split('\t');
      endMs = Number(end);
      role = label as SpeakerRole;
      name = person === '-' ? null : (person ?? null);
      text = words.join('\t');
      if (!person || !['wearer', 'other', 'unknown'].includes(role)) throw new Error(`Invalid fake script line ${index + 1}`);
    } else {
      const [delay, label, ...words] = line.split('|');
      const seconds = Number(delay?.trim());
      const person = label?.trim();
      if (!delay?.trim() || !Number.isFinite(seconds) || seconds <= 0 || !person) throw new Error(`Invalid fake script line ${index + 1}`);
      endMs = previous + seconds * 1000;
      const keyword = person.toLowerCase(); // "Wearer" and "wearer" are the same role; names keep their case
      role = keyword === 'wearer' ? 'wearer' : keyword === 'unknown' ? 'unknown' : 'other';
      name = role === 'other' && keyword !== 'other' ? person : null;
      // Pipe formatting spaces are not transcript content; internal pipes remain.
      text = words.join('|').trim();
    }
    if (!Number.isFinite(endMs) || endMs <= previous || !text.trim()) throw new Error(`Invalid fake script line ${index + 1}`);
    const startMs = Math.max(previous, endMs - 400);
    previous = endMs;
    return { text, startMs, endMs, name: role === 'unknown' ? null : name, role, isWearer: role === 'wearer' };
  });
}
