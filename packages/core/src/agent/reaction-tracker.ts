/**
 * User Reaction Signal Tracker — detect acceptance/rejection of agent responses.
 * Analyzes user messages for satisfaction signals per session.
 * Injected as context so the agent knows what worked and what didn't.
 */

export type ReactionSignal = 'accepted' | 'rejected' | 'neutral';

export interface ReactionEntry {
  turn: number;
  signal: ReactionSignal;
  userMessage: string;
}

const POSITIVE_PATTERNS = [
  /^(perfect|great|thanks|good|nice|awesome|yes|ok|looks good|lgtm)/i,
  /\bthat works\b/i, /\bthat's right\b/i, /\bexactly\b/i,
];

const NEGATIVE_PATTERNS = [
  /^(no|wrong|undo|revert|fix|that's not|that isn't)/i,
  /\bstill broken\b/i, /\bdoesn't work\b/i, /\btry again\b/i,
  /\bnot what I\b/i, /\bwhat I asked\b/i,
];

export class ReactionTracker {
  private reactions: ReactionEntry[] = [];

  /** Analyze a user message and record the reaction signal. */
  record(turn: number, userMessage: string): ReactionSignal {
    const signal = classifyReaction(userMessage);
    this.reactions.push({ turn, signal, userMessage: userMessage.slice(0, 100) });

    // Keep only last 20 reactions
    if (this.reactions.length > 20) {
      this.reactions = this.reactions.slice(-20);
    }

    return signal;
  }

  /** Get the last N reactions. */
  getRecent(n = 5): ReactionEntry[] {
    return this.reactions.slice(-n);
  }

  /** Format reaction context for system prompt injection. */
  formatReactionContext(): string {
    const recent = this.getRecent(5);
    if (recent.length === 0) return '';

    const accepted = recent.filter((r) => r.signal === 'accepted').length;
    const rejected = recent.filter((r) => r.signal === 'rejected').length;

    if (rejected === 0 && accepted === 0) return '';

    const parts: string[] = [];
    if (accepted > 0) parts.push(`${accepted} accepted`);
    if (rejected > 0) parts.push(`${rejected} rejected`);

    return `[Recent reactions: ${parts.join(', ')} out of last ${recent.length} responses]`;
  }

  clear(): void {
    this.reactions = [];
  }
}

function classifyReaction(message: string): ReactionSignal {
  const trimmed = message.trim();

  // Check positive patterns
  for (const p of POSITIVE_PATTERNS) {
    if (p.test(trimmed)) return 'accepted';
  }

  // Check negative patterns
  for (const p of NEGATIVE_PATTERNS) {
    if (p.test(trimmed)) return 'rejected';
  }

  // If message immediately follows with a new task (no comment on previous), treat as accepted
  if (trimmed.length > 50 && !trimmed.includes('?')) {
    return 'accepted'; // Long message with new instructions = moved on
  }

  return 'neutral';
}
