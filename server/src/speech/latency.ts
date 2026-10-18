export type LatencyMeasurement = {
  questionId: string;
  transcriptMs: number;
  totalMs?: number;
  withinTarget?: boolean;
};

/** C calls markDisplayed only after A acknowledges an actual display, using server time. */
export class SpeechLatencyTracker {
  private pending = new Map<string, { endedAt: number; transcriptMs: number }>();
  constructor(private readonly targetMs = 2000) {}
  markFinal(questionId: string, endedAt: number, finalAt = Date.now()): LatencyMeasurement {
    const transcriptMs = Math.max(0, finalAt - endedAt);
    this.pending.set(questionId, { endedAt, transcriptMs });
    if (this.pending.size > 1000) this.pending.delete(this.pending.keys().next().value!);
    return { questionId, transcriptMs };
  }
  markDisplayed(questionId: string, displayedAt = Date.now()): LatencyMeasurement | null {
    const pending = this.pending.get(questionId);
    if (!pending) return null;
    this.pending.delete(questionId);
    const totalMs = Math.max(0, displayedAt - pending.endedAt);
    return { questionId, transcriptMs: pending.transcriptMs, totalMs, withinTarget: totalMs <= this.targetMs };
  }
  clear(): void { this.pending.clear(); }
}
