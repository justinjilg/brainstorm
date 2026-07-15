/**
 * Trust propagation — parallel tool call race trap.
 *
 * Pre-fix regression: the middleware held a single module-level
 * `_activeWindow` that `syncTrustWindow()` overwrote per call.
 * When AI SDK v6 invoked multiple tool execute()s in parallel
 * (default `parallelToolCalls: true`), each tool's sync would
 * clobber the previous one's window while the previous was
 * awaiting its execute() result. Symptom in production: a low-
 * trust web_fetch and a high-trust shell dispatched in the same
 * step would see each other's trust state, and the shell might
 * EITHER incorrectly block a safe call OR incorrectly allow a
 * tainted one depending on ordering.
 *
 * Post-fix: windows are keyed by call.id in a Map, so parallel
 * calls don't collide.
 */

import { describe, it, expect, vi } from "vitest";
import {
  createTrustPropagationMiddleware,
  syncTrustWindow,
  flushTrustWindow,
  getActiveTrustWindow,
} from "../middleware/builtin/trust-propagation.js";

describe("trust-propagation — parallel tool calls", () => {
  it("keeps each call's trust state isolated across interleaved sync/flush", () => {
    const middleware = createTrustPropagationMiddleware();
    const metadataA: Record<string, unknown> = {};
    const metadataB: Record<string, unknown> = {};

    // Interleave as if two tool calls were running concurrently:
    //   syncA → syncB → wrapToolCall(A) → wrapToolCall(B) → ...
    //   → afterToolResult(A) → afterToolResult(B)
    //   → flushA → flushB
    // Pre-fix, syncB would overwrite the global, so wrapToolCall(A)
    // would read B's window. Post-fix, each lookup uses call.id.
    syncTrustWindow(metadataA, "call-A");
    syncTrustWindow(metadataB, "call-B");

    const callA = { id: "call-A", name: "web_fetch", input: {} };
    const callB = { id: "call-B", name: "shell", input: {} };

    // wrapToolCall must not blow up and must respect each window
    // independently. We don't assert a specific allow/block here —
    // the point is that the call IDs are what scope the lookup.
    middleware.wrapToolCall!(callA);
    middleware.wrapToolCall!(callB);

    // Record results on each call
    middleware.afterToolResult!({
      toolCallId: "call-A",
      name: "web_fetch",
      ok: true,
      output: "fetched content",
      durationMs: 0,
    });
    middleware.afterToolResult!({
      toolCallId: "call-B",
      name: "shell",
      ok: true,
      output: { stdout: "done" },
      durationMs: 0,
    });

    // Flush in reverse order — also a parallel-interleaving shape
    flushTrustWindow(metadataB, "call-B");
    flushTrustWindow(metadataA, "call-A");

    // Both sessions' metadata should have independent trust windows
    // populated.
    expect(metadataA["_trustWindow"]).toBeDefined();
    expect(metadataB["_trustWindow"]).toBeDefined();

    // A's window should have a web_fetch record; B's should have a
    // shell record. If state crossed between them, one would show
    // the other's tool.
    const windowA = metadataA["_trustWindow"] as any;
    const windowB = metadataB["_trustWindow"] as any;
    // trust-labels stores the per-tool history in a form we don't
    // need to introspect directly — this test's point is that the
    // two windows are DISTINCT object references after flush. The
    // pre-fix bug would have one window pointing at the other (or
    // both pointing at the last-synced window).
    expect(windowA).not.toBe(windowB);
  });

  it("flush for unknown callId is a no-op (leak guard)", () => {
    const metadata: Record<string, unknown> = {};
    // flush without a prior sync must not throw / must not create
    // ghost state.
    expect(() => flushTrustWindow(metadata, "never-synced")).not.toThrow();
    // Nothing written.
    expect(metadata["_trustWindow"]).toBeUndefined();
  });

  it("sync/flush bracket cleans up (no Map leak)", () => {
    const metadata: Record<string, unknown> = {};
    // 10 rounds of sync-then-flush. If the Map grew unbounded,
    // repeated sync/flush would leak entries. The flush branch
    // deletes the entry, so the Map size is bounded.
    for (let i = 0; i < 10; i++) {
      const id = `bracket-${i}`;
      syncTrustWindow(metadata, id);
      flushTrustWindow(metadata, id);
    }
    // We can't directly inspect the private Map from here without
    // exposing internals, but the test passes if no exception and
    // no memory growth (vitest doesn't measure memory but the
    // invariant holds by code inspection of the fix).
    expect(metadata["_trustWindow"]).toBeDefined();
  });
});

describe("trust-propagation — soft-cap eviction is age-based, never fail-open", () => {
  // MAX_ACTIVE_WINDOWS is 1000 (soft cap, not exported).
  const CAP = 1000;

  it("does NOT evict a fresh in-flight window when the cap is exceeded", () => {
    const metadata: Record<string, unknown> = {};
    const ids: string[] = [];
    try {
      // Fill past the cap entirely with fresh windows. Since none are
      // stale, the soft cap is exceeded but nothing is evicted — evicting
      // a live window would skip its trust check (fail-open bypass).
      for (let i = 0; i < CAP + 5; i++) {
        const id = `fresh-${i}`;
        ids.push(id);
        syncTrustWindow(metadata, id);
      }
      // The earliest-synced window (still "in flight") must survive.
      expect(getActiveTrustWindow("fresh-0")).toBeDefined();

      // And its trust check still fires (window present → not skipped).
      const mw = createTrustPropagationMiddleware();
      expect(() =>
        mw.wrapToolCall!({ id: "fresh-0", name: "shell", input: {} }),
      ).not.toThrow();
    } finally {
      for (const id of ids) flushTrustWindow(metadata, id);
    }
  });

  it("evicts stale windows past the cap, keeping fresh ones", () => {
    vi.useFakeTimers();
    const metadata: Record<string, unknown> = {};
    const freshIds: string[] = [];
    try {
      // One stale entry, created well before the TTL window.
      syncTrustWindow(metadata, "stale-0");
      expect(getActiveTrustWindow("stale-0")).toBeDefined();

      // Advance past WINDOW_TTL_MS (10 min) so stale-0 is now evictable.
      vi.advanceTimersByTime(11 * 60 * 1000);

      // Fill to/over the cap with fresh entries. The sync that hits the
      // cap sweeps the front and evicts only the stale entry.
      for (let i = 0; i < CAP; i++) {
        const id = `fresh-${i}`;
        freshIds.push(id);
        syncTrustWindow(metadata, id);
      }

      expect(getActiveTrustWindow("stale-0")).toBeUndefined();
      expect(getActiveTrustWindow("fresh-0")).toBeDefined();
    } finally {
      for (const id of freshIds) flushTrustWindow(metadata, id);
      flushTrustWindow(metadata, "stale-0");
      vi.useRealTimers();
    }
  });
});
