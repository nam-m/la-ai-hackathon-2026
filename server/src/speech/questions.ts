/** Deliberately local: matching may use AI, but captured answers are never rewritten. */
export function isQuestion(text: string): boolean {
  const normalized = text.trim().replace(/^["“'‘]+/, '').replace(/["”'’]+$/, '');
  // Trust punctuation when the provider gives it: "?" is a question, "." or "!" is not
  // ("What a lovely day!", "Do it now.", "Have a good one."). Starter words decide only unpunctuated text.
  if (/\?\s*$/.test(normalized)) return true;
  // A trailing "..." or "…" means trailing off, not a full stop: let the starter words decide.
  if (/(?<!\.)[.!]\s*$/.test(normalized)) return false;
  // (?!['’]t\b) keeps "can't" from counting as "can"; "who's"/"what's" still count.
  return /^(?:who|what|when|where|why|how|which|whose|whom|can|could|would|will|should|shall|is|are|am|was|were|do|does|did|have|has|had)\b(?!['’]t\b)/i.test(normalized);
}
