/**
 * Docker Sandbox Pool — reuses warm containers across acquisitions.
 *
 * Bind mounts are fixed at `docker run` time (see docker-sandbox.ts), so a
 * container can never be re-pointed at another workspace. Pooling is
 * therefore keyed by `image + hostWorkspace` (canonicalized absolute path)
 * — an idle container is only ever handed back to a caller asking for the
 * exact same image/workspace pair it was created for.
 *
 * `release()` runs a best-effort hygiene reset (kill stray processes, wipe
 * /tmp) before parking a container as idle. If that reset fails, the
 * container is stopped rather than risk leaking state between callers.
 */

import { resolve } from "node:path";
import { DockerSandbox } from "./docker-sandbox.js";

export interface SandboxPoolConfig {
  enabled: boolean;
  maxIdlePerKey: number;
  maxIdleTotal: number;
  idleTimeoutMs: number;
}

const DEFAULT_CONFIG: SandboxPoolConfig = {
  enabled: true,
  maxIdlePerKey: 2,
  maxIdleTotal: 4,
  idleTimeoutMs: 300_000,
};

/** Minimal surface the pool depends on — real DockerSandbox satisfies this. */
export interface SandboxLike {
  start(): void;
  exec(command: string): {
    output: string;
    exitCode: number;
    durationMs: number;
  };
  stop(): void;
  isRunning(): boolean;
  getContainerId(): string | null;
}

export interface AcquireOpts {
  image?: string;
  hostWorkspace: string;
  timeout?: number;
}

interface ParkedSandbox {
  sandbox: SandboxLike;
  timer: ReturnType<typeof setTimeout>;
}

// NOTE: DockerSandbox.exec() already wraps every command in
// `/bin/sh -c "<command>; echo SENTINEL$?"`, so `$$` inside this command
// already refers to that wrapper shell's own PID — do NOT add another
// `sh -c '...'` layer here, or `$$` will resolve to a *different* process
// (the inner shell) and the loop will kill the outer wrapper before it can
// print the sentinel, making every hygiene reset look like a failure.
const HYGIENE_RESET_COMMAND =
  'for p in $(ls /proc | grep "^[0-9]*$"); do [ "$p" != "1" ] && [ "$p" != "$$" ] && kill -9 "$p" 2>/dev/null; done; rm -rf /tmp/* /tmp/.[!.]* 2>/dev/null; true';

function keyFor(opts: AcquireOpts): string {
  const image = opts.image ?? "node:22-slim";
  const hostWorkspace = resolve(opts.hostWorkspace);
  // The per-command timeout is baked into each DockerSandbox at construction,
  // so it must be part of the pool key — otherwise a parked default-timeout
  // container would be handed to a caller that asked for a custom timeout,
  // silently ignoring the configured value.
  const timeout = opts.timeout ?? "default";
  return `${image}::${hostWorkspace}::${timeout}`;
}

// A single process-level `exit` listener drains every currently-tracked
// pool, rather than each pool instance registering its own listener. This
// keeps listener count constant regardless of how many pools get created
// (tests, reconfiguration, etc.) and lets `untrackPool` drop a replaced
// singleton so it becomes GC-able instead of being retained forever by a
// listener closure.
const trackedPools = new Set<DockerSandboxPool>();
let globalExitHookRegistered = false;

function trackPool(pool: DockerSandboxPool): void {
  trackedPools.add(pool);
  if (globalExitHookRegistered) return;
  globalExitHookRegistered = true;
  process.on("exit", () => {
    // execFileSync-based stop() works synchronously inside an exit
    // handler; async cleanup would not.
    for (const p of trackedPools) {
      p.drain();
    }
  });
}

function untrackPool(pool: DockerSandboxPool): void {
  trackedPools.delete(pool);
}

export class DockerSandboxPool {
  private cfg: SandboxPoolConfig;
  private idle: Map<string, ParkedSandbox[]> = new Map();
  private inUse: Set<SandboxLike> = new Set();
  private keyOf: Map<SandboxLike, string> = new Map();
  private createSandbox: (opts: AcquireOpts) => SandboxLike;

  constructor(
    cfg?: Partial<SandboxPoolConfig>,
    createSandbox?: (opts: AcquireOpts) => SandboxLike,
  ) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.createSandbox =
      createSandbox ??
      ((opts: AcquireOpts) => {
        const sandbox = new DockerSandbox({
          hostWorkspace: opts.hostWorkspace,
          ...(opts.image ? { image: opts.image } : {}),
          ...(opts.timeout ? { timeout: opts.timeout } : {}),
        });
        sandbox.start();
        return sandbox;
      });

    trackPool(this);
  }

  /**
   * `isRunning()` on the real DockerSandbox is pure local bookkeeping
   * (containerId !== null) — it stays true even if the container died out
   * from under us (daemon restart, OOM-killed keepalive, manual `docker
   * rm`). Probe liveness cheaply before handing a parked container back.
   */
  private isAlive(sandbox: SandboxLike): boolean {
    try {
      const result = sandbox.exec("true");
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  acquire(opts: AcquireOpts): SandboxLike {
    if (!this.cfg.enabled) {
      return this.createSandbox(opts);
    }

    const key = keyFor(opts);
    const bucket = this.idle.get(key);

    while (bucket && bucket.length > 0) {
      const parked = bucket.pop()!;
      clearTimeout(parked.timer);
      if (parked.sandbox.isRunning() && this.isAlive(parked.sandbox)) {
        this.inUse.add(parked.sandbox);
        this.keyOf.set(parked.sandbox, key);
        return parked.sandbox;
      }
      // Dead idle container — it may still hold an Exited container record
      // on the daemon (containers aren't started with --rm), so stop() it
      // before discarding, then keep looking at the next parked entry.
      try {
        parked.sandbox.stop();
      } catch {
        /* best-effort */
      }
    }

    const sandbox = this.createSandbox(opts);
    this.inUse.add(sandbox);
    this.keyOf.set(sandbox, key);
    return sandbox;
  }

  release(sandbox: SandboxLike): void {
    const key = this.keyOf.get(sandbox);
    this.inUse.delete(sandbox);
    this.keyOf.delete(sandbox);

    if (!this.cfg.enabled || !key) {
      sandbox.stop();
      return;
    }

    let resetOk = false;
    try {
      const result = sandbox.exec(HYGIENE_RESET_COMMAND);
      resetOk = result.exitCode === 0;
    } catch {
      resetOk = false;
    }

    if (!resetOk) {
      sandbox.stop();
      return;
    }

    this.park(key, sandbox);
  }

  private park(key: string, sandbox: SandboxLike): void {
    const bucket = this.idle.get(key) ?? [];
    this.idle.set(key, bucket);

    const timer = setTimeout(() => {
      this.evict(key, sandbox);
    }, this.cfg.idleTimeoutMs);
    timer.unref?.();

    bucket.push({ sandbox, timer });

    // Enforce per-key cap: evict oldest first.
    while (bucket.length > this.cfg.maxIdlePerKey) {
      const oldest = bucket.shift()!;
      clearTimeout(oldest.timer);
      oldest.sandbox.stop();
    }

    // Enforce total cap: evict globally oldest-parked entries first.
    while (this.idleCount() > this.cfg.maxIdleTotal) {
      this.evictOldestOverall();
    }
  }

  private evict(key: string, sandbox: SandboxLike): void {
    const bucket = this.idle.get(key);
    if (!bucket) return;
    const idx = bucket.findIndex((p) => p.sandbox === sandbox);
    if (idx === -1) return;
    const [parked] = bucket.splice(idx, 1);
    clearTimeout(parked.timer);
    parked.sandbox.stop();
    if (bucket.length === 0) this.idle.delete(key);
  }

  private evictOldestOverall(): void {
    // "Oldest" = first parked among all buckets in insertion order. Since
    // each bucket's array is itself insertion-ordered, and we don't track
    // cross-bucket ordering explicitly, evict from the bucket holding the
    // longest-idle entry via a simple linear scan — pool sizes here are
    // tiny (maxIdleTotal default 4), so this is fine.
    let oldestKey: string | null = null;
    let oldestSandbox: SandboxLike | null = null;

    for (const [key, bucket] of this.idle) {
      if (bucket.length > 0) {
        oldestKey = key;
        oldestSandbox = bucket[0].sandbox;
        break;
      }
    }

    if (oldestKey && oldestSandbox) {
      this.evict(oldestKey, oldestSandbox);
    }
  }

  prewarm(opts: AcquireOpts): void {
    if (!this.cfg.enabled) return;
    const key = keyFor(opts);
    const bucket = this.idle.get(key);
    if (bucket && bucket.some((p) => p.sandbox.isRunning())) return;

    try {
      const sandbox = this.createSandbox(opts);
      this.park(key, sandbox);
    } catch {
      /* fire-and-forget: swallow warm-start failures */
    }
  }

  drain(): void {
    for (const bucket of this.idle.values()) {
      for (const parked of bucket) {
        clearTimeout(parked.timer);
        parked.sandbox.stop();
      }
    }
    this.idle.clear();
    // Also stop any checked-out containers. These are started without --rm
    // and keepalive on `tail -f /dev/null`, so a container still in use at
    // process exit (the global exit hook calls drain) would otherwise orphan
    // indefinitely along with its workspace bind mount.
    for (const sandbox of this.inUse) {
      try {
        sandbox.stop();
      } catch {
        /* best-effort: exiting anyway */
      }
    }
    this.inUse.clear();
    this.keyOf.clear();
  }

  idleCount(): number {
    let total = 0;
    for (const bucket of this.idle.values()) total += bucket.length;
    return total;
  }
}

let poolSingleton: DockerSandboxPool | null = null;

export function getSandboxPool(): DockerSandboxPool {
  if (!poolSingleton) {
    poolSingleton = new DockerSandboxPool();
  }
  return poolSingleton;
}

export function configureSandboxPool(cfg: Partial<SandboxPoolConfig>): void {
  if (poolSingleton) {
    poolSingleton.drain();
    untrackPool(poolSingleton);
  }
  poolSingleton = new DockerSandboxPool(cfg);
}
