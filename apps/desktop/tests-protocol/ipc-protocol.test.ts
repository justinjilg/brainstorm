/**
 * Protocol-tier tests for the IPC wire format.
 *
 * These run under vitest — fast, no Electron, no Vite. They exercise
 * the pure primitives in src/lib/ipc-protocol.ts so each named
 * contract has a dedicated trap. When we change the wire format on
 * purpose we update the test in the same commit; when we change it
 * by accident we find out immediately.
 *
 * Precedent: `test_subprocess_buffering.py` in anthropics/claude-
 * agent-sdk-python treats the NDJSON parsing layer as a first-class
 * testable unit for exactly this reason.
 */

import { describe, expect, it } from "vitest";
import {
  isBackendReadyMessage,
  isStreamingEvent,
  normalizeChatEvent,
  parseBackendLine,
} from "../src/lib/ipc-protocol";

describe("normalizeChatEvent", () => {
  it("passes through non-object inputs untouched", () => {
    expect(normalizeChatEvent(null)).toBe(null);
    expect(normalizeChatEvent(undefined)).toBe(undefined);
    expect(normalizeChatEvent("string")).toBe("string");
    expect(normalizeChatEvent(42)).toBe(42);
  });

  it("passes through already-normalized shapes (type present)", () => {
    const input = { type: "text-delta", delta: "hi" };
    const out = normalizeChatEvent(input);
    expect(out).toBe(input); // same reference — no rewrite
  });

  it("rewrites {id, event, data} → {type, ...data}", () => {
    const out = normalizeChatEvent({
      id: "stream-7",
      event: "text-delta",
      data: { delta: "hello" },
    });
    expect(out).toMatchObject({ type: "text-delta", delta: "hello" });
  });

  it("drops the transport-level id field — consumers don't read it", () => {
    const out = normalizeChatEvent({
      id: "stream-1",
      event: "done",
      data: { cost: 0.0042 },
    });
    expect((out as Record<string, unknown>).id).toBeUndefined();
  });

  it("protects `type` from being clobbered by payload keys", () => {
    // If a backend ever accidentally emits data: { type: "evil" }, the
    // discriminator must still resolve to the transport's event field.
    // Otherwise a payload could spoof its own event type.
    const out = normalizeChatEvent({
      event: "tool-result",
      data: { type: "evil", output: "ok" },
    });
    expect(out.type).toBe("tool-result");
  });

  it("handles missing data field gracefully", () => {
    const out = normalizeChatEvent({ event: "session", id: "x" });
    expect(out).toMatchObject({ type: "session" });
  });

  it("leaves objects without type or event alone", () => {
    const input = { foo: "bar" };
    expect(normalizeChatEvent(input)).toBe(input);
  });
});

describe("parseBackendLine", () => {
  it("returns null for empty / whitespace-only lines", () => {
    expect(parseBackendLine("")).toBe(null);
    expect(parseBackendLine("   ")).toBe(null);
    expect(parseBackendLine("\t\n")).toBe(null);
  });

  it("returns null for non-JSON text (e.g. pino logs leaking into stdout)", () => {
    // A classic failure mode: a tool spawns a subprocess that prints
    // pino-like text to stdout instead of stderr, and the parser
    // tries to JSON.parse it. Must not throw.
    expect(parseBackendLine("[INFO] Something happened")).toBe(null);
    expect(parseBackendLine("{ invalid json without closing brace")).toBe(null);
  });

  it("returns null for JSON arrays and scalars (we only accept objects)", () => {
    expect(parseBackendLine("[1, 2, 3]")).toBe(null);
    expect(parseBackendLine('"just a string"')).toBe(null);
    expect(parseBackendLine("42")).toBe(null);
    expect(parseBackendLine("true")).toBe(null);
    expect(parseBackendLine("null")).toBe(null);
  });

  it("parses a well-formed backend message", () => {
    const out = parseBackendLine(
      '{"id":"1","event":"text-delta","data":{"delta":"hi"}}',
    );
    expect(out).toEqual({
      id: "1",
      event: "text-delta",
      data: { delta: "hi" },
    });
  });

  it("tolerates internal whitespace and trailing newlines", () => {
    expect(parseBackendLine('   {"type":"ready"}  \n')).toEqual({
      type: "ready",
    });
  });

  it("accepts embedded newlines inside JSON strings", () => {
    // NDJSON's frame boundary is the top-level newline; a \n character
    // inside a string literal must NOT split the frame. main.ts reads
    // via readline which already handles this, but the parser itself
    // must not choke either.
    const out = parseBackendLine(
      '{"event":"text-delta","data":{"delta":"a\\nb"}}',
    );
    expect(out).toMatchObject({
      data: { delta: "a\nb" },
    });
  });

  it("handles large 50KB+ messages", () => {
    const bigDelta = "x".repeat(50_000);
    const line = JSON.stringify({
      event: "text-delta",
      data: { delta: bigDelta },
    });
    const out = parseBackendLine(line);
    expect(out?.data).toMatchObject({ delta: bigDelta });
  });
});

describe("isBackendReadyMessage", () => {
  it("recognizes the structured ready signal", () => {
    expect(isBackendReadyMessage({ type: "ready" })).toBe(true);
    expect(isBackendReadyMessage({ type: "ready", version: "0.14.0" })).toBe(
      true,
    );
  });

  it("rejects other message shapes, including near-misses", () => {
    expect(isBackendReadyMessage({ type: "done" })).toBe(false);
    expect(isBackendReadyMessage({ event: "ready" })).toBe(false);
    expect(
      isBackendReadyMessage({ event: "ready", data: { type: "ready" } }),
    ).toBe(false);
    // The old pre-fix codepath inferred readiness from stderr logs
    // containing the word "ready". The new contract is strict — ONLY
    // top-level {type:"ready"}. This test guards against a silent
    // regression back to substring matching.
    expect(isBackendReadyMessage({ message: "agent ready" })).toBe(false);
  });
});

describe("isStreamingEvent", () => {
  it("recognizes messages with an event field", () => {
    expect(isStreamingEvent({ event: "text-delta" })).toBe(true);
    expect(isStreamingEvent({ id: "1", event: "done", data: {} })).toBe(true);
  });

  it("rejects request/response replies and status messages", () => {
    expect(isStreamingEvent({ id: "1", result: "ok" })).toBe(false);
    expect(isStreamingEvent({ type: "ready" })).toBe(false);
    expect(isStreamingEvent({})).toBe(false);
  });
});
