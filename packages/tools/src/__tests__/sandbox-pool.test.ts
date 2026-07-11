/**
 * DockerSandboxPool bookkeeping tests.
 *
 * Most tests run against a fake sandbox object (no Docker required) via
 * the pool's factory seam. One integration test exercises a real
 * container and is skipped when Docker is unavailable, matching the
 * gating style used in docker-sandbox-death.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DockerSandboxPool,
  type SandboxLike,
  type AcquireOpts,
} from "../sandbox/sandbox-pool.js";
import { DockerSandbox } from "../sandbox/docker-sandbox.js";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

const docker = dockerAvailable();

class FakeSandbox implements SandboxLike {
  id: string;
  running = true;
  stopped = false;
  execResults: Array<{ output: string; exitCode: number; durationMs: number }> =
    [];
  execCalls: string[] = [];

  constructor(id: string) {
    this.id = id;
  }

  start(): void {
    this.running = true;
  }

  exec(command: string): {
    output: string;
    exitCode: number;
    durationMs: number;
  } {
    this.execCalls.push(command);
    if (this.execResults.length > 0) {
      return this.execResults.shift()!;
    }
    return { output: "", exitCode: 0, durationMs: 1 };
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  getContainerId(): string | null {
    return this.id;
  }
}

function makeFactory() {
  let counter = 0;
  const created: FakeSandbox[] = [];
  const factory = (_opts: AcquireOpts): SandboxLike => {
    const sandbox = new FakeSandbox(`fake-${counter++}`);
    created.push(sandbox);
    return sandbox;
  };
  return { factory, created };
}

describe("DockerSandboxPool (bookkeeping, no Docker required)", () => {
  it("acquire creates a new sandbox when nothing is idle", () => {
    const { factory, created } = makeFactory();
    const pool = new DockerSandboxPool({}, factory);

    const sandbox = pool.acquire({ hostWorkspace: "/tmp/ws-a" });

    expect(created.length).toBe(1);
    expect(sandbox).toBe(created[0]);
    pool.drain();
  });

  it("release parks and a second acquire for the same key returns the same instance", () => {
    const { factory, created } = makeFactory();
    const pool = new DockerSandboxPool({}, factory);

    const first = pool.acquire({ hostWorkspace: "/tmp/ws-a" });
    pool.release(first);
    expect(pool.idleCount()).toBe(1);

    const second = pool.acquire({ hostWorkspace: "/tmp/ws-a" });

    expect(second).toBe(first);
    expect(created.length).toBe(1);
    expect(pool.idleCount()).toBe(0);
    pool.drain();
  });

  it("different hostWorkspace keys never share containers", () => {
    const { factory, created } = makeFactory();
    const pool = new DockerSandboxPool({}, factory);

    const a = pool.acquire({ hostWorkspace: "/tmp/ws-a" });
    pool.release(a);
    const b = pool.acquire({ hostWorkspace: "/tmp/ws-b" });

    expect(b).not.toBe(a);
    expect(created.length).toBe(2);
    pool.drain();
  });

  it("different images with the same hostWorkspace never share containers", () => {
    const { factory, created } = makeFactory();
    const pool = new DockerSandboxPool({}, factory);

    const a = pool.acquire({
      hostWorkspace: "/tmp/ws-a",
      image: "node:22-slim",
    });
    pool.release(a);
    const b = pool.acquire({
      hostWorkspace: "/tmp/ws-a",
      image: "python:3-slim",
    });

    expect(b).not.toBe(a);
    expect(created.length).toBe(2);
    pool.drain();
  });

  it("maxIdlePerKey eviction stops the oldest parked container", () => {
    const { factory } = makeFactory();
    const pool = new DockerSandboxPool(
      { maxIdlePerKey: 2, maxIdleTotal: 10 },
      factory,
    );

    const s1 = pool.acquire({ hostWorkspace: "/tmp/ws-a" }) as FakeSandbox;
    const s2 = pool.acquire({ hostWorkspace: "/tmp/ws-a" }) as FakeSandbox;
    const s3 = pool.acquire({ hostWorkspace: "/tmp/ws-a" }) as FakeSandbox;

    pool.release(s1);
    pool.release(s2);
    expect(pool.idleCount()).toBe(2);

    pool.release(s3);

    expect(pool.idleCount()).toBe(2);
    expect(s1.stopped).toBe(true);
    expect(s2.stopped).toBe(false);
    expect(s3.stopped).toBe(false);
    pool.drain();
  });

  it("maxIdleTotal eviction stops oldest across keys", () => {
    const { factory } = makeFactory();
    const pool = new DockerSandboxPool(
      { maxIdlePerKey: 10, maxIdleTotal: 2 },
      factory,
    );

    const a1 = pool.acquire({ hostWorkspace: "/tmp/ws-a" }) as FakeSandbox;
    const b1 = pool.acquire({ hostWorkspace: "/tmp/ws-b" }) as FakeSandbox;
    const c1 = pool.acquire({ hostWorkspace: "/tmp/ws-c" }) as FakeSandbox;

    pool.release(a1);
    pool.release(b1);
    expect(pool.idleCount()).toBe(2);

    pool.release(c1);

    expect(pool.idleCount()).toBe(2);
    expect(a1.stopped).toBe(true);
    pool.drain();
  });

  it("failed hygiene reset (nonzero exit) stops instead of parking", () => {
    const { factory } = makeFactory();
    const pool = new DockerSandboxPool({}, factory);

    const sandbox = pool.acquire({ hostWorkspace: "/tmp/ws-a" }) as FakeSandbox;
    sandbox.execResults.push({ output: "boom", exitCode: 1, durationMs: 1 });

    pool.release(sandbox);

    expect(sandbox.stopped).toBe(true);
    expect(pool.idleCount()).toBe(0);
    pool.drain();
  });

  it("hygiene reset throwing also stops instead of parking", () => {
    const { factory } = makeFactory();
    const pool = new DockerSandboxPool({}, factory);

    const sandbox = pool.acquire({ hostWorkspace: "/tmp/ws-a" }) as FakeSandbox;
    sandbox.exec = () => {
      throw new Error("docker exec failed");
    };

    pool.release(sandbox);

    expect(sandbox.stopped).toBe(true);
    expect(pool.idleCount()).toBe(0);
    pool.drain();
  });

  it("a dead idle container (isRunning false) is discarded on acquire", () => {
    const { factory, created } = makeFactory();
    const pool = new DockerSandboxPool({}, factory);

    const sandbox = pool.acquire({ hostWorkspace: "/tmp/ws-a" }) as FakeSandbox;
    pool.release(sandbox);
    sandbox.running = false; // died while idle

    const second = pool.acquire({ hostWorkspace: "/tmp/ws-a" });

    expect(second).not.toBe(sandbox);
    expect(created.length).toBe(2);
    pool.drain();
  });

  it("idle timeout evicts a parked container", () => {
    vi.useFakeTimers();
    try {
      const { factory } = makeFactory();
      const pool = new DockerSandboxPool({ idleTimeoutMs: 1000 }, factory);

      const sandbox = pool.acquire({
        hostWorkspace: "/tmp/ws-a",
      }) as FakeSandbox;
      pool.release(sandbox);
      expect(pool.idleCount()).toBe(1);

      vi.advanceTimersByTime(1001);

      expect(pool.idleCount()).toBe(0);
      expect(sandbox.stopped).toBe(true);
      pool.drain();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drain stops everything and clears idle state", () => {
    const { factory } = makeFactory();
    const pool = new DockerSandboxPool({}, factory);

    const a = pool.acquire({ hostWorkspace: "/tmp/ws-a" }) as FakeSandbox;
    const b = pool.acquire({ hostWorkspace: "/tmp/ws-b" }) as FakeSandbox;
    pool.release(a);
    pool.release(b);

    pool.drain();

    expect(pool.idleCount()).toBe(0);
    expect(a.stopped).toBe(true);
    expect(b.stopped).toBe(true);
  });

  it("disabled config: acquire always creates, release always stops", () => {
    const { factory, created } = makeFactory();
    const pool = new DockerSandboxPool({ enabled: false }, factory);

    const a = pool.acquire({ hostWorkspace: "/tmp/ws-a" }) as FakeSandbox;
    pool.release(a);

    expect(a.stopped).toBe(true);
    expect(pool.idleCount()).toBe(0);

    const b = pool.acquire({ hostWorkspace: "/tmp/ws-a" });
    expect(b).not.toBe(a);
    expect(created.length).toBe(2);
    pool.drain();
  });

  it("prewarm creates and parks a container when none idle for the key", () => {
    const { factory, created } = makeFactory();
    const pool = new DockerSandboxPool({}, factory);

    pool.prewarm({ hostWorkspace: "/tmp/ws-a" });

    expect(created.length).toBe(1);
    expect(pool.idleCount()).toBe(1);

    const acquired = pool.acquire({ hostWorkspace: "/tmp/ws-a" });
    expect(acquired).toBe(created[0]);
    pool.drain();
  });

  it("prewarm is a no-op when an idle container already exists for the key", () => {
    const { factory, created } = makeFactory();
    const pool = new DockerSandboxPool({}, factory);

    const first = pool.acquire({ hostWorkspace: "/tmp/ws-a" });
    pool.release(first);

    pool.prewarm({ hostWorkspace: "/tmp/ws-a" });

    expect(created.length).toBe(1);
    expect(pool.idleCount()).toBe(1);
    pool.drain();
  });

  it("prewarm swallows errors from the factory", () => {
    const pool = new DockerSandboxPool({}, () => {
      throw new Error("docker run failed");
    });

    expect(() => pool.prewarm({ hostWorkspace: "/tmp/ws-a" })).not.toThrow();
    expect(pool.idleCount()).toBe(0);
  });
});

describe("configureSandboxPool / getSandboxPool singleton", () => {
  beforeEach(async () => {
    // Reset module state between tests by re-importing is not possible with
    // a static import; instead we exercise the exported functions directly
    // and rely on drain() being idempotent.
  });

  it("configureSandboxPool drains the old singleton before replacing it", async () => {
    const { getSandboxPool, configureSandboxPool } =
      await import("../sandbox/sandbox-pool.js");

    configureSandboxPool({ enabled: true });
    const pool1 = getSandboxPool();
    const drainSpy = vi.spyOn(pool1, "drain");

    configureSandboxPool({ enabled: true, maxIdleTotal: 8 });
    const pool2 = getSandboxPool();

    expect(drainSpy).toHaveBeenCalledTimes(1);
    expect(pool2).not.toBe(pool1);
    expect(pool2.idleCount()).toBe(0);
  });
});

describe.skipIf(!docker)("DockerSandboxPool integration (real Docker)", () => {
  let pool: DockerSandboxPool;

  afterEach(() => {
    pool?.drain();
  });

  it("acquire-release-acquire reuses the same container and hygiene-resets it", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brainstorm-sandbox-pool-"));
    pool = new DockerSandboxPool({ enabled: true });

    const first = pool.acquire({
      image: "busybox:latest",
      hostWorkspace: workspace,
    }) as unknown as DockerSandbox;
    const firstId = first.getContainerId();
    expect(firstId).toBeTruthy();

    // Leave a leftover background process running.
    first.exec("sh -c 'sleep 300 &'");

    pool.release(first as unknown as SandboxLike);
    expect(pool.idleCount()).toBe(1);

    const second = pool.acquire({
      image: "busybox:latest",
      hostWorkspace: workspace,
    }) as unknown as DockerSandbox;

    expect(second.getContainerId()).toBe(firstId);

    // The stray `sleep 300` should have been reaped by the hygiene reset.
    const check = second.exec("pgrep -f 'sleep 300' || echo none");
    expect(check.output).toMatch(/none/);

    pool.release(second as unknown as SandboxLike);
  }, 60_000);
});
