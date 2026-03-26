/**
 * Lightweight user tone detection — heuristic-based, no ML.
 * Analyzes recent user messages to detect frustration, urgency, or exploration.
 * Used internally to adjust agent behavior (not shown to user).
 */

export type UserTone = 'calm' | 'frustrated' | 'urgent' | 'exploring' | 'appreciative';

const PATTERNS: Record<UserTone, RegExp[]> = {
  frustrated: [
    /\?\?+/, /!!+/,
    /^(no|wrong|fix|broken|still|why)\b/i,
    /doesn't work/i, /not working/i, /that's wrong/i,
    /^undo/i, /^revert/i,
  ],
  urgent: [
    /\basap\b/i, /\bquickly\b/i, /^just /i,
    /\bright now\b/i, /\bhurry\b/i,
  ],
  exploring: [
    /\bwhat if\b/i, /\bcould we\b/i, /\bhow about\b/i,
    /\bconsider\b/i, /\balternatively\b/i, /\bmaybe\b/i,
  ],
  appreciative: [
    /\bperfect\b/i, /\bgreat\b/i, /\bthanks\b/i,
    /\blove it\b/i, /\bamazing\b/i, /\bgood job\b/i,
    /\bnice\b/i, /\bawesome\b/i,
  ],
  calm: [], // default — no patterns
};

export interface ToneResult {
  tone: UserTone;
  confidence: number;
}

/** Detect the dominant tone from the last N user messages. */
export function detectTone(messages: string[], lookback = 3): ToneResult {
  const recent = messages.slice(-lookback);
  if (recent.length === 0) return { tone: 'calm', confidence: 0 };

  const scores: Record<UserTone, number> = {
    calm: 0,
    frustrated: 0,
    urgent: 0,
    exploring: 0,
    appreciative: 0,
  };

  for (const msg of recent) {
    for (const [tone, patterns] of Object.entries(PATTERNS) as [UserTone, RegExp[]][]) {
      for (const p of patterns) {
        if (p.test(msg)) {
          scores[tone]++;
        }
      }
    }

    // Short terse messages after corrections suggest frustration
    if (msg.length < 20 && recent.length > 1) {
      scores.frustrated += 0.5;
    }
  }

  // Find dominant tone
  let maxTone: UserTone = 'calm';
  let maxScore = 0;
  for (const [tone, score] of Object.entries(scores) as [UserTone, number][]) {
    if (score > maxScore) {
      maxTone = tone;
      maxScore = score;
    }
  }

  const confidence = Math.min(maxScore / recent.length, 1);
  return { tone: maxTone, confidence };
}

/** Get guidance text for the agent based on detected tone. */
export function toneGuidance(tone: UserTone): string {
  switch (tone) {
    case 'frustrated':
      return 'User tone: frustrated. Be direct, lead with the fix, skip explanations unless asked.';
    case 'urgent':
      return 'User tone: urgent. Minimize reads, write directly, skip exploration.';
    case 'exploring':
      return 'User tone: exploring. Offer alternatives, explain trade-offs, be collaborative.';
    case 'appreciative':
      return 'User tone: satisfied. Continue current approach.';
    default:
      return '';
  }
}
