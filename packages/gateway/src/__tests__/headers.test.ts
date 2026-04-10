/**
 * Gateway smoke test — first test for the gateway package.
 */

import { describe, it, expect } from "vitest";
import { parseGatewayHeaders, formatGatewayFeedback } from "../headers.js";

describe("Gateway Headers", () => {
  it("parses empty headers without crashing", () => {
    const result = parseGatewayHeaders({});
    expect(result).toBeDefined();
  });

  it("formats feedback payload", () => {
    const feedback = formatGatewayFeedback({
      guardianStatus: "passed",
      estimatedCost: 0.05,
      actualCost: 0.04,
      selectedModel: "anthropic/claude-sonnet-4-6",
      requestId: "req-123",
    });
    expect(feedback).toBeDefined();
    expect(typeof feedback).toBe("string");
  });
});
