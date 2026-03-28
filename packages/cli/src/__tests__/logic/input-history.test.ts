/**
 * InputHistory tests — navigation, dedup, draft preservation.
 *
 * Mocks filesystem to prevent reading/writing ~/.brainstorm/input-history.json.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock filesystem before importing InputHistory
vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

const { InputHistory } = await import("../../input-history.js");

describe("InputHistory", () => {
  let history: InstanceType<typeof InputHistory>;

  beforeEach(() => {
    history = new InputHistory();
  });

  // ── Push ──────────────────────────────────────────────────────────

  it("stores pushed entries", () => {
    history.push("hello");
    history.push("world");
    expect(history.getAll()).toEqual(["hello", "world"]);
  });

  it("trims whitespace on push", () => {
    history.push("  hello  ");
    expect(history.getAll()).toEqual(["hello"]);
  });

  it("ignores empty/whitespace-only push", () => {
    history.push("");
    history.push("   ");
    expect(history.getAll()).toEqual([]);
  });

  it("deduplicates consecutive identical entries", () => {
    history.push("hello");
    history.push("hello");
    history.push("hello");
    expect(history.getAll()).toEqual(["hello"]);
  });

  it("allows non-consecutive duplicates", () => {
    history.push("hello");
    history.push("world");
    history.push("hello");
    expect(history.getAll()).toEqual(["hello", "world", "hello"]);
  });

  // ── Navigation ─────────────────────────────────────────────────────

  it("returns null on up() with empty history", () => {
    expect(history.up("")).toBeNull();
  });

  it("navigates up through entries (newest first)", () => {
    history.push("first");
    history.push("second");
    history.push("third");

    expect(history.up("current")).toBe("third");
    expect(history.up("current")).toBe("second");
    expect(history.up("current")).toBe("first");
  });

  it("returns null when navigating past oldest entry", () => {
    history.push("only");
    history.up("current"); // → "only"
    expect(history.up("current")).toBeNull();
  });

  it("navigates down back to newer entries", () => {
    history.push("first");
    history.push("second");

    history.up("current"); // → "second"
    history.up("current"); // → "first"
    expect(history.down()).toBe("second");
  });

  it("restores draft when navigating past newest", () => {
    history.push("old");
    history.up("my draft"); // → "old"
    expect(history.down()).toBe("my draft");
  });

  it("returns null on down() when not navigating", () => {
    history.push("something");
    expect(history.down()).toBeNull();
  });

  it("returns null on down() at bottom of history", () => {
    history.push("only");
    history.up("draft"); // → "only"
    history.down(); // → "draft"
    expect(history.down()).toBeNull(); // already at bottom
  });

  // ── Reset ──────────────────────────────────────────────────────────

  it("resetCursor returns to bottom", () => {
    history.push("first");
    history.push("second");
    history.up(""); // → "second"
    history.up(""); // → "first"
    history.resetCursor();

    // After reset, up should start from the end again
    expect(history.up("new")).toBe("second");
  });

  it("push resets cursor automatically", () => {
    history.push("first");
    history.up(""); // → "first"
    history.push("second");

    // Cursor reset — up starts from end
    expect(history.up("")).toBe("second");
  });

  // ── Capacity ───────────────────────────────────────────────────────

  it("trims entries beyond MAX_MEMORY (100)", () => {
    for (let i = 0; i < 150; i++) {
      history.push(`entry-${i}`);
    }
    const all = history.getAll();
    expect(all.length).toBe(100);
    expect(all[0]).toBe("entry-50"); // oldest retained
    expect(all[99]).toBe("entry-149"); // newest
  });
});
