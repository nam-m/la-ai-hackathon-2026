/** Deliberately local: matching may use AI, but captured answers are never rewritten. */
export function isQuestion(text: string): boolean {
  const normalized = text.trim().replace(/^["“'‘]+/, '').replace(/["”'’]+$/, '');
  return /\?\s*$/.test(normalized) || /^(?:who|what|when|where|why|how|which|whose|whom|can|could|would|will|should|shall|is|are|am|was|were|do|does|did|have|has|had)\b/i.test(normalized);
}
