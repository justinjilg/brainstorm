import { describe, it, expect } from "vitest";
import { encodePathSegment } from "../connectors/path-segment.js";

describe("encodePathSegment", () => {
  it("percent-encodes benign characters", () => {
    expect(encodePathSegment("abc-123")).toBe("abc-123");
    expect(encodePathSegment("hello world")).toBe("hello%20world");
    expect(encodePathSegment("a+b=c")).toBe("a%2Bb%3Dc");
  });

  it("rejects path traversal sequences", () => {
    expect(() => encodePathSegment("..")).toThrow(/traversal/);
    expect(() => encodePathSegment("..safe")).toThrow(/traversal/);
    expect(() => encodePathSegment("foo..bar")).toThrow(/traversal/);
  });

  it("rejects path separators — including attempts to inject segments", () => {
    expect(() => encodePathSegment("admin/keys")).toThrow(/path separator/);
    expect(() => encodePathSegment("a\\b")).toThrow(/path separator/);
    // The classic "break out of /devices/:id/ into /admin/keys" payload:
    expect(() => encodePathSegment("123/../admin/keys")).toThrow();
  });

  it("rejects NUL and other control characters", () => {
    expect(() => encodePathSegment("a\x00b")).toThrow(/control/);
    expect(() => encodePathSegment("a\x1bb")).toThrow(/control/);
    expect(() => encodePathSegment("a\x7fb")).toThrow(/control/);
  });

  it("rejects empty or non-string input", () => {
    expect(() => encodePathSegment("")).toThrow(/empty/);
    expect(() => encodePathSegment(null as unknown as string)).toThrow(
      /non-string|empty/,
    );
  });

  it("accepts UUID-like ids unchanged", () => {
    expect(encodePathSegment("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });
});
