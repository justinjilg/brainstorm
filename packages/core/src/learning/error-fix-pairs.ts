/**
 * Error-Fix Pair Detection — "Why Did That Work?" analysis.
 *
 * Detects when the agent fixes a build error:
 *   Turn N: build fails with error message
 *   Turn N+1: agent edits files
 *   Turn N+2: build passes
 *
 * Captures the error signature + fix description for future reference.
 * When the same error occurs again, the stored fix is suggested.
 */

import type { PatternRepository } from "@brainst0rm/db";

export interface ErrorFixPair {
  errorSignature: string;
  filesChanged: string[];
  fixDescription: string;
  timestamp: number;
}

/** Normalize an error message into a stable signature for matching. */
export function normalizeErrorSignature(errorMessage: string): string {
  return (
    errorMessage
      // Strip file paths (they vary between projects)
      .replace(/\/[\w./\-]+\.\w{1,5}/g, "<path>")
      // Strip line numbers
      .replace(/:\d+:\d+/g, ":<line>")
      .replace(/line \d+/gi, "line <N>")
      // Strip timestamps
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/g, "<timestamp>")
      // Normalize whitespace
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200)
  );
}

export class ErrorFixTracker {
  private lastError: {
    message: string;
    signature: string;
    turn: number;
  } | null = null;
  private lastEdits: { files: string[]; turn: number } | null = null;

  /** Record a build/test failure. */
  recordError(errorMessage: string, turn: number): void {
    this.lastError = {
      message: errorMessage,
      signature: normalizeErrorSignature(errorMessage),
      turn,
    };
  }

  /** Record file edits (potential fix). */
  recordEdits(files: string[], turn: number): void {
    this.lastEdits = { files, turn };
  }

  /**
   * Record a build/test success. If we had error → edits → success,
   * this completes the fix pair.
   */
  detectFixPair(turn: number): ErrorFixPair | null {
    if (!this.lastError || !this.lastEdits) return null;

    // Check temporal sequence: error → edits → success within ~3 turns
    if (
      this.lastEdits.turn > this.lastError.turn &&
      turn > this.lastEdits.turn &&
      turn - this.lastError.turn <= 5
    ) {
      const pair: ErrorFixPair = {
        errorSignature: this.lastError.signature,
        filesChanged: this.lastEdits.files,
        fixDescription: `Fixed by editing ${this.lastEdits.files.map((f) => f.split("/").pop()).join(", ")}`,
        timestamp: Date.now(),
      };

      // Reset state
      this.lastError = null;
      this.lastEdits = null;

      return pair;
    }

    return null;
  }

  /** Store a detected fix pair in the pattern database. */
  storeFixPair(
    repo: PatternRepository,
    projectPath: string,
    pair: ErrorFixPair,
  ): void {
    repo.record(
      projectPath,
      "tool_success", // Reuse existing pattern type
      `fix:${pair.errorSignature.slice(0, 100)}`,
      pair.fixDescription,
      0.7,
    );
  }

  /** Look up known fixes for an error. */
  lookupFix(
    repo: PatternRepository,
    projectPath: string,
    errorMessage: string,
  ): string | null {
    const signature = normalizeErrorSignature(errorMessage);
    const patterns = repo.getForProject(projectPath, "tool_success");
    const match = patterns.find(
      (p) => p.key === `fix:${signature.slice(0, 100)}`,
    );
    if (match && match.confidence >= 0.5) {
      return `Known fix (seen ${match.occurrences}x): ${match.value}`;
    }
    return null;
  }

  reset(): void {
    this.lastError = null;
    this.lastEdits = null;
  }
}
