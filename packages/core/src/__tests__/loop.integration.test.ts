import { describe, it, expect } from "vitest";
import { LoopDetector } from "../agent/loop-detector";
import {
  estimateTokenCount,
  needsCompaction,
  getContextPercent,
} from "../session/compaction";

/**
 * Agent loop integration tests.
 * Tests loop detection, compaction triggers, and token estimation
 * without requiring an LLM connection.
 */

describe("LoopDetector", () => {
  it("detects consecutive reads without write", () => {
    const detector = new LoopDetector(3, 3);
    detector.recordToolCall("file_read", "/a.ts");
    detector.recordToolCall("file_read", "/b.ts");
    const warnings = detector.recordToolCall("file_read", "/c.ts");
    expect(warnings.some((w) => w.type === "consecutive-reads")).toBe(true);
  });

  it("detects duplicate file read", () => {
    const detector = new LoopDetector();
    detector.recordToolCall("file_read", "/a.ts");
    const warnings = detector.recordToolCall("file_read", "/a.ts");
    expect(warnings.some((w) => w.type === "duplicate-read")).toBe(true);
  });

  it("detects tool repeat", () => {
    const detector = new LoopDetector(10, 3);
    detector.recordToolCall("grep");
    detector.recordToolCall("grep");
    const warnings = detector.recordToolCall("grep");
    expect(warnings.some((w) => w.type === "tool-repeat")).toBe(true);
  });

  it("escalates after consecutive warnings", () => {
    const detector = new LoopDetector(2, 2);
    // First call with warning (duplicate)
    detector.recordToolCall("file_read", "/a.ts");
    detector.recordToolCall("file_read", "/a.ts"); // consecutiveWarnings = 1

    // Second call with warning — should trigger escalation at threshold 2
    const warnings = detector.recordToolCall("file_read", "/a.ts"); // consecutiveWarnings = 2
    expect(warnings.some((w) => w.type === "escalation")).toBe(true);
  });

  it("resets consecutive warning count on clean call", () => {
    const detector = new LoopDetector(2, 10);
    detector.recordToolCall("file_read", "/a.ts");
    detector.recordToolCall("file_read", "/a.ts"); // warning

    // Clean call (write) resets
    detector.recordToolCall("file_write");

    // New reads shouldn't escalate immediately
    detector.recordToolCall("file_read", "/b.ts");
    const warnings = detector.recordToolCall("file_read", "/b.ts");
    expect(warnings.some((w) => w.type === "escalation")).toBe(false);
  });

  it("resets on reset()", () => {
    const detector = new LoopDetector();
    detector.recordToolCall("file_read", "/a.ts");
    detector.reset();
    const warnings = detector.recordToolCall("file_read", "/a.ts");
    expect(warnings.some((w) => w.type === "duplicate-read")).toBe(false);
  });
});

describe("Token estimation", () => {
  it("estimates tokens from messages", () => {
    const messages = [
      { role: "user" as const, content: "Hello, how are you?" },
      {
        role: "assistant" as const,
        content: "I am doing well, thank you for asking!",
      },
    ];
    const tokens = estimateTokenCount(messages);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(100);
  });

  it("returns higher count for longer messages", () => {
    const short = [{ role: "user" as const, content: "Hi" }];
    const long = [{ role: "user" as const, content: "A".repeat(1000) }];
    expect(estimateTokenCount(long)).toBeGreaterThan(estimateTokenCount(short));
  });
});

describe("Compaction triggers", () => {
  it("does not need compaction for small history", () => {
    const messages = [
      { role: "user" as const, content: "Hello" },
      { role: "assistant" as const, content: "Hi there" },
    ];
    expect(needsCompaction(messages, 100000)).toBe(false);
  });

  it("needs compaction when approaching context limit", () => {
    const messages = Array.from({ length: 200 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: "A".repeat(2000),
    }));
    // 200 messages * ~2000 chars each = ~400K chars = ~100K tokens
    // Context window of 50K should trigger compaction
    expect(needsCompaction(messages, 50000)).toBe(true);
  });

  it("reports context percent correctly", () => {
    const messages = [{ role: "user" as const, content: "A".repeat(400) }];
    const tokens = estimateTokenCount(messages);
    const percent = getContextPercent(messages, tokens * 2);
    expect(percent).toBe(50);
  });
});
