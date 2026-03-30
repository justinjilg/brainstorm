/**
 * Consensus Review — multi-agent code review with 2-of-3 voting.
 *
 * Spawns 3 reviewers (security, code quality, style) in parallel,
 * each on a different model to prevent groupthink. Collects verdicts
 * and applies consensus logic: 2-of-3 pass = approved, any critical = blocked.
 *
 * Learned from: Living Case Study — single-reviewer reviews missed that
 * .go files were markdown documents. Multiple reviewers with different
 * perspectives catch different classes of issues.
 */

export type ReviewVerdict = "pass" | "fail" | "critical";

export interface ReviewerResult {
  reviewerId: string;
  reviewerRole: string;
  verdict: ReviewVerdict;
  findings: string[];
  fullText: string;
  model: string;
  cost: number;
}

export interface ConsensusResult {
  consensus: "approved" | "rejected" | "critical-block";
  passCount: number;
  failCount: number;
  criticalCount: number;
  reviews: ReviewerResult[];
  totalCost: number;
  summary: string;
}

/**
 * Parse a verdict from the first line of a review response.
 * Expects: "VERDICT: PASS" or "VERDICT: FAIL" or "VERDICT: CRITICAL"
 */
export function parseVerdict(text: string): ReviewVerdict {
  const firstLine = text.split("\n")[0].toUpperCase();
  if (firstLine.includes("CRITICAL")) return "critical";
  if (firstLine.includes("FAIL")) return "fail";
  return "pass";
}

/**
 * Apply consensus logic to a set of review results.
 * - 2-of-3 pass = approved
 * - Any critical = critical-block (regardless of other verdicts)
 * - Otherwise = rejected
 */
export function applyConsensus(reviews: ReviewerResult[]): ConsensusResult {
  const passCount = reviews.filter((r) => r.verdict === "pass").length;
  const failCount = reviews.filter((r) => r.verdict === "fail").length;
  const criticalCount = reviews.filter((r) => r.verdict === "critical").length;
  const totalCost = reviews.reduce((s, r) => s + r.cost, 0);

  let consensus: ConsensusResult["consensus"];
  if (criticalCount > 0) {
    consensus = "critical-block";
  } else if (passCount >= 2) {
    consensus = "approved";
  } else {
    consensus = "rejected";
  }

  const verdictNames = reviews.map(
    (r) => `${r.reviewerRole}: ${r.verdict.toUpperCase()}`,
  );
  const summary = `${consensus} (${passCount}/${reviews.length} pass, ${criticalCount} critical). ${verdictNames.join(", ")}`;

  return {
    consensus,
    passCount,
    failCount,
    criticalCount,
    reviews,
    totalCost,
    summary,
  };
}

/**
 * Build a review prompt for a specific reviewer role.
 */
export function buildReviewPrompt(
  role: "security" | "code-quality" | "style",
  code: string,
  featureTitle: string,
): { system: string; user: string } {
  const roleInstructions: Record<string, string> = {
    security:
      "Focus on: authentication/authorization flaws, injection risks, credential handling, input validation, error information leakage. Cite specific function names and patterns.",
    "code-quality":
      "Focus on: correctness, error handling, resource management, concurrency issues, API design, test coverage gaps. Cite specific functions and logic paths.",
    style:
      "Focus on: naming conventions, code organization, documentation, idiomatic patterns, consistency, maintainability. Cite specific examples.",
  };

  return {
    system: `You are a ${role} code reviewer. ${roleInstructions[role]}\n\nFirst line of your response MUST be exactly: VERDICT: PASS or VERDICT: FAIL or VERDICT: CRITICAL\nThen provide numbered findings. Be specific — cite function names, line patterns, exact issues.`,
    user: `Review the following code for "${featureTitle}":\n\n${code}`,
  };
}
