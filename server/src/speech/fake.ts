import { readFileSync } from 'node:fs';
import type { Utterance } from './types.js';

export type FakeLine = Pick<Utterance, 'text' | 'startMs' | 'endMs' | 'isWearer' | 'name'>;

/** TSV: endMs, wearer|other, name (or -), verbatim transcript. */
export function readFakeScript(path?: string): FakeLine[] {
  const input = readFileSync(path ?? new URL('../../scripts/fake-script.txt', import.meta.url), 'utf8');
  let previous = 0;
  return input.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#')).map((line, index) => {
    const [end, role, name, ...words] = line.split('\t');
    const endMs = Number(end);
    const text = words.join('\t');
    if (!Number.isFinite(endMs) || endMs < previous || endMs < 0 || !['wearer', 'other'].includes(role ?? '') || !name || !text.trim()) {
      throw new Error(`Invalid fake script line ${index + 1}; expected endMs<TAB>wearer|other<TAB>name<TAB>text`);
    }
    const startMs = Math.max(previous, endMs - 400);
    previous = endMs;
    return { text, startMs, endMs, name: name === '-' ? null : name, isWearer: role === 'wearer' };
  });
}
