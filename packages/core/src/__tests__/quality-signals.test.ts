import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Quality-signals middleware tests. Pins the sample-size gates so the
 * Dogfood #1 Bug 3 false positive (1 read / 3 writes warning on session
 * startup) stays fixed.
 *
 * We mock @brainst0rm/shared's createLogger so we can observe .warn() calls
 * directly. Pino writes to fd 2 via its destination stream, which bypasses
 * process.stderr.write — a plain stderr spy wouldn't catch anything.
 */

const warnSpy = vi.fn();
vi.mock("@brainst0rm/shared", async () => {
  const actual =
    await vi.importActual<typeof import("@brainst0rm/shared")>(
      "@brainst0rm/shared",
    );
  return {
    ...actual,
    createLogger: () => ({
      warn: warnSpy,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
    }),
  };
});

// Import AFTER the mock is set up.
const { createQualitySignalsMiddleware } =
  await import("../middleware/builtin/quality-signals.js");

function didWarn(): boolean {
  return warnSpy.mock.calls.some((call) =>
    String(call[1] ?? "").includes("Read:Edit ratio below threshold"),
  );
}

function warnCount(): number {
  return warnSpy.mock.calls.filter((call) =>
    String(call[1] ?? "").includes("Read:Edit ratio below threshold"),
  ).length;
}

describe("createQualitySignalsMiddleware", () => {
  beforeEach(() => {
    warnSpy.mockClear();
  });

  function fireResult(
    mw: ReturnType<typeof createQualitySignalsMiddleware>,
    name: string,
  ) {
    mw.afterToolResult?.({
      name,
      args: {},
      output: null,
      durationMs: 1,
    } as any);
  }

  it("does NOT warn at 1 read / 3 writes (below MIN_TOTAL_CALLS)", () => {
    const mw = createQualitySignalsMiddleware();
    fireResult(mw, "file_read");
    fireResult(mw, "file_write");
    fireResult(mw, "file_write");
    fireResult(mw, "file_write");
    expect(didWarn()).toBe(false);
  });

  it("does NOT warn at 4 writes with low ratio (below MIN_WRITES=5)", () => {
    const mw = createQualitySignalsMiddleware();
    for (let i = 0; i < 6; i++) fireResult(mw, "file_read");
    for (let i = 0; i < 4; i++) fireResult(mw, "file_write");
    // 6 reads / 4 writes = 1.5 ratio, total 10 calls, but writes < 5
    expect(didWarn()).toBe(false);
  });

  it("DOES warn at 5 writes with bad ratio AND ≥10 total calls", () => {
    const mw = createQualitySignalsMiddleware();
    for (let i = 0; i < 5; i++) fireResult(mw, "file_read");
    for (let i = 0; i < 5; i++) fireResult(mw, "file_write");
    // 5 reads / 5 writes = 1.0 ratio, total 10 calls, writes ≥ 5 — should warn
    expect(didWarn()).toBe(true);
  });

  it("does NOT warn when ratio is healthy even past thresholds", () => {
    const mw = createQualitySignalsMiddleware();
    for (let i = 0; i < 20; i++) fireResult(mw, "file_read");
    for (let i = 0; i < 5; i++) fireResult(mw, "file_write");
    // 20 reads / 5 writes = 4.0 ratio — above 3.0 threshold
    expect(didWarn()).toBe(false);
  });

  it("warns only ONCE per session even when ratio stays bad", () => {
    const mw = createQualitySignalsMiddleware();
    for (let i = 0; i < 5; i++) fireResult(mw, "file_read");
    for (let i = 0; i < 5; i++) fireResult(mw, "file_write");
    expect(didWarn()).toBe(true);
    const firstCount = warnCount();

    // Do more writes — still bad ratio — should not emit second warning
    for (let i = 0; i < 5; i++) fireResult(mw, "file_write");

    expect(warnCount()).toBe(firstCount);
  });
});
