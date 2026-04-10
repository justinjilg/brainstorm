import { describe, it, expect } from "vitest";
import {
  extractConfidence,
  determineEscalation,
  isReviewApproved,
} from "../confidence.js";
import type { Artifact } from "@brainst0rm/shared";

function makeArtifact(
  content: string,
  contentType: Artifact["contentType"] = "text",
): Artifact {
  return {
    id: "test-artifact",
    stepId: "step-1",
    agentId: "agent-1",
    content,
    contentType,
    iteration: 0,
    timestamp: Date.now(),
    metadata: {},
    confidence: 1.0,
    cost: 0,
  };
}

describe("extractConfidence", () => {
  it("extracts confidence from structured JSON", () => {
    const artifact = makeArtifact(
      JSON.stringify({ confidence: 0.85, result: "ok" }),
      "json",
    );
    expect(extractConfidence(artifact)).toBe(0.85);
  });

  it("clamps JSON confidence to [0, 1]", () => {
    expect(
      extractConfidence(
        makeArtifact(JSON.stringify({ confidence: 1.5 }), "json"),
      ),
    ).toBe(1);
    expect(
      extractConfidence(
        makeArtifact(JSON.stringify({ confidence: -0.3 }), "json"),
      ),
    ).toBe(0);
  });

  it("detects low confidence from uncertain language", () => {
    expect(
      extractConfidence(makeArtifact("I am not sure this approach works")),
    ).toBe(0.4);
    expect(extractConfidence(makeArtifact("This might not be correct"))).toBe(
      0.4,
    );
  });

  it("detects medium confidence from hedge words", () => {
    expect(
      extractConfidence(makeArtifact("I'm fairly confident this should work")),
    ).toBe(0.7);
  });

  it("detects high confidence from certain language", () => {
    expect(
      extractConfidence(makeArtifact("I am confident this will work")),
    ).toBe(0.9);
  });

  it("returns 0.6 default for neutral text", () => {
    expect(extractConfidence(makeArtifact("Here is the implementation"))).toBe(
      0.6,
    );
  });

  it("handles invalid JSON gracefully", () => {
    const artifact = makeArtifact("not valid json {", "json");
    expect(extractConfidence(artifact)).toBe(0.6);
  });
});

describe("determineEscalation", () => {
  it("continues when confidence meets threshold", () => {
    expect(determineEscalation(0.8, 0.7, true)).toBe("continue");
  });

  it("continues when confidence equals threshold", () => {
    expect(determineEscalation(0.7, 0.7, true)).toBe("continue");
  });

  it("pauses on large deficit (>0.3)", () => {
    expect(determineEscalation(0.3, 0.7, true)).toBe("pause");
  });

  it("retries on small deficit when canRetry is true", () => {
    expect(determineEscalation(0.5, 0.7, true)).toBe("retry");
  });

  it("continues on marginal deficit (<= 0.1)", () => {
    expect(determineEscalation(0.65, 0.7, true)).toBe("continue");
  });

  it("continues on small deficit when canRetry is false", () => {
    // deficit is 0.2 (> 0.1) but canRetry is false → falls through to continue
    expect(determineEscalation(0.5, 0.7, false)).toBe("continue");
  });
});

describe("isReviewApproved", () => {
  it("approves from structured JSON", () => {
    expect(
      isReviewApproved(
        makeArtifact(JSON.stringify({ approved: true }), "json"),
      ),
    ).toBe(true);
  });

  it("rejects from structured JSON", () => {
    expect(
      isReviewApproved(
        makeArtifact(JSON.stringify({ approved: false }), "json"),
      ),
    ).toBe(false);
  });

  it("approves from 'LGTM' text", () => {
    expect(isReviewApproved(makeArtifact("LGTM, looks good"))).toBe(true);
  });

  it("approves from 'approved' text", () => {
    expect(isReviewApproved(makeArtifact("This change is approved"))).toBe(
      true,
    );
  });

  it("rejects from 'rejected' text", () => {
    expect(isReviewApproved(makeArtifact("Rejected — needs changes"))).toBe(
      false,
    );
  });

  it("rejects from 'issues found' text", () => {
    expect(
      isReviewApproved(makeArtifact("3 issues found in the implementation")),
    ).toBe(false);
  });

  it("rejects from 'critical' text", () => {
    expect(
      isReviewApproved(makeArtifact("Critical bug in the auth flow")),
    ).toBe(false);
  });

  it("defaults to not approved for ambiguous text", () => {
    expect(isReviewApproved(makeArtifact("Here are my review comments"))).toBe(
      false,
    );
  });

  it("rejection takes precedence over approval language", () => {
    // "not approved" contains "approved" but should still reject
    expect(isReviewApproved(makeArtifact("not approved"))).toBe(false);
  });
});
