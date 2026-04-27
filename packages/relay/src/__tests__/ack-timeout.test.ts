import { describe, it, expect } from "vitest";
import { AckTimeoutManager } from "../ack-timeout.js";

// Simple fake clock — collects pending callbacks and lets tests advance time
// deterministically. setTimeout returns an opaque handle (a counter); cancel
// removes it from the queue. fire() runs all callbacks whose due time has
// elapsed.

class FakeClock {
  private now = 0;
  private nextHandle = 1;
  private readonly pending = new Map<
    number,
    { dueAt: number; cb: () => void }
  >();

  setTimeout = (cb: () => void, ms: number): unknown => {
    const handle = this.nextHandle++;
    this.pending.set(handle, { dueAt: this.now + ms, cb });
    return handle;
  };

  clearTimeout = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };

  /** Advance time by `ms`; fire any callbacks whose dueAt <= new now. */
  advance(ms: number): void {
    this.now += ms;
    for (const [handle, entry] of Array.from(this.pending)) {
      if (entry.dueAt <= this.now) {
        this.pending.delete(handle);
        entry.cb();
      }
    }
  }
}

describe("AckTimeoutManager", () => {
  it("fires callback after timeoutMs", () => {
    const clock = new FakeClock();
    const mgr = new AckTimeoutManager({
      timeoutMs: 5000,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const fired: string[] = [];
    mgr.start("cmd-1", (cid) => fired.push(cid));
    clock.advance(4999);
    expect(fired).toEqual([]);
    clock.advance(2);
    expect(fired).toEqual(["cmd-1"]);
    expect(mgr.isActive("cmd-1")).toBe(false);
  });

  it("cancel before fire prevents callback", () => {
    const clock = new FakeClock();
    const mgr = new AckTimeoutManager({
      timeoutMs: 5000,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const fired: string[] = [];
    mgr.start("cmd-1", (cid) => fired.push(cid));
    expect(mgr.cancel("cmd-1")).toBe(true);
    expect(mgr.isActive("cmd-1")).toBe(false);
    clock.advance(10000);
    expect(fired).toEqual([]);
  });

  it("cancel after fire is a no-op", () => {
    const clock = new FakeClock();
    const mgr = new AckTimeoutManager({
      timeoutMs: 5000,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const fired: string[] = [];
    mgr.start("cmd-1", (cid) => fired.push(cid));
    clock.advance(6000);
    expect(fired).toEqual(["cmd-1"]);
    // Cancel after fire returns false (no-op) and doesn't double-fire
    expect(mgr.cancel("cmd-1")).toBe(false);
    expect(fired).toEqual(["cmd-1"]);
  });

  it("multiple concurrent timers fire independently", () => {
    const clock = new FakeClock();
    const mgr = new AckTimeoutManager({
      timeoutMs: 5000,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const fired: string[] = [];
    mgr.start("cmd-1", (cid) => fired.push(cid));
    clock.advance(2000);
    mgr.start("cmd-2", (cid) => fired.push(cid));
    clock.advance(3000); // cmd-1 fires at total 5000ms
    expect(fired).toEqual(["cmd-1"]);
    clock.advance(2000); // cmd-2 fires at total 7000ms (started at 2000, +5000)
    expect(fired).toEqual(["cmd-1", "cmd-2"]);
  });

  it("rejects starting a duplicate timer for same command_id", () => {
    const clock = new FakeClock();
    const mgr = new AckTimeoutManager({
      timeoutMs: 5000,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    mgr.start("cmd-1", () => {});
    expect(() => mgr.start("cmd-1", () => {})).toThrow(/already active/);
  });

  it("cancelAll cancels all pending timers", () => {
    const clock = new FakeClock();
    const mgr = new AckTimeoutManager({
      timeoutMs: 5000,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const fired: string[] = [];
    mgr.start("cmd-1", (cid) => fired.push(cid));
    mgr.start("cmd-2", (cid) => fired.push(cid));
    expect(mgr.count()).toBe(2);
    mgr.cancelAll();
    expect(mgr.count()).toBe(0);
    clock.advance(10000);
    expect(fired).toEqual([]);
  });
});
