import { describe, it, expect } from "vitest";
import { riskLevelOf } from "./risk-level";

describe("riskLevelOf", () => {
  it("returns 'low' for scores below 30", () => {
    expect(riskLevelOf(0)).toBe("low");
    expect(riskLevelOf(15)).toBe("low");
    expect(riskLevelOf(29)).toBe("low");
  });

  it("returns 'medium' for 30..59", () => {
    expect(riskLevelOf(30)).toBe("medium");
    expect(riskLevelOf(45)).toBe("medium");
    expect(riskLevelOf(59)).toBe("medium");
  });

  it("returns 'high' for 60..79", () => {
    expect(riskLevelOf(60)).toBe("high");
    expect(riskLevelOf(70)).toBe("high");
    expect(riskLevelOf(79)).toBe("high");
  });

  it("returns 'critical' for 80+", () => {
    expect(riskLevelOf(80)).toBe("critical");
    expect(riskLevelOf(95)).toBe("critical");
    expect(riskLevelOf(100)).toBe("critical");
  });

  it("handles edge cases at exact thresholds", () => {
    expect(riskLevelOf(30)).toBe("medium"); // not "low"
    expect(riskLevelOf(60)).toBe("high"); // not "medium"
    expect(riskLevelOf(80)).toBe("critical"); // not "high"
  });
});
