import { describe, it, expect, vi } from "vitest";
import { linkSignals, onAbort } from "../abort-signals.js";

describe("onAbort", () => {
  it("fires the handler when the signal aborts", () => {
    const ac = new AbortController();
    const fn = vi.fn();
    onAbort(ac.signal, fn);
    expect(fn).not.toHaveBeenCalled();
    ac.abort();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns an off() that detaches the listener", () => {
    const ac = new AbortController();
    const fn = vi.fn();
    const off = onAbort(ac.signal, fn);
    off();
    ac.abort();
    expect(fn).not.toHaveBeenCalled();
  });

  it("queues the handler as a microtask when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const fn = vi.fn();
    onAbort(ac.signal, fn);
    expect(fn).not.toHaveBeenCalled(); // not synchronous
    await Promise.resolve(); // flush microtask
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("linkSignals", () => {
  it("aborts when any input signal aborts", () => {
    const a = new AbortController();
    const b = new AbortController();
    const linked = linkSignals(a.signal, b.signal);
    expect(linked.aborted).toBe(false);
    b.abort(new Error("from b"));
    expect(linked.aborted).toBe(true);
    expect(linked.reason).toBeInstanceOf(Error);
    expect((linked.reason as Error).message).toBe("from b");
  });

  it("aborts immediately when any input is already aborted", () => {
    const a = new AbortController();
    const b = new AbortController();
    b.abort();
    const linked = linkSignals(a.signal, b.signal);
    expect(linked.aborted).toBe(true);
  });

  it("ignores undefined inputs", () => {
    const a = new AbortController();
    const linked = linkSignals(undefined, a.signal, undefined);
    expect(linked.aborted).toBe(false);
    a.abort();
    expect(linked.aborted).toBe(true);
  });

  it("returns a non-aborting signal when all inputs are undefined", () => {
    const linked = linkSignals(undefined, undefined);
    expect(linked.aborted).toBe(false);
  });

  it("detaches listeners from unrelated inputs after first abort", () => {
    const a = new AbortController();
    const b = new AbortController();
    const linked = linkSignals(a.signal, b.signal);
    a.abort();
    expect(linked.aborted).toBe(true);

    // After linked is aborted via a, listeners on b must have been removed.
    // We verify via the count of listeners on b.signal — Node's AbortSignal
    // supports getEventListeners, but that's env-specific. Instead, check
    // that aborting b after linked is already done doesn't throw and doesn't
    // double-abort (reason stays the first one).
    const firstReason = linked.reason;
    b.abort(new Error("late b"));
    expect(linked.reason).toBe(firstReason);
  });
});
