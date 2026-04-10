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
      sessionId: "test-session",
      modelId: "anthropic/claude-sonnet-4.6",
      success: true,
      latencyMs: 500,
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(feedback).toBeDefined();
    expect(typeof feedback).toBe("string");
  });
});
