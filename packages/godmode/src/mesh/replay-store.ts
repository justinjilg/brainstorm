/**
 * Distributed replay protection for A2A Idempotency-Key.
 *
 * The store is keyed on (Idempotency-Key → task_id) with a 10-minute TTL.
 * BrainstormRouter runs on multi-instance ECS, so an in-memory LRU is NOT
 * sufficient: a replay can route to a different task whose memory has
 * never seen the key. This is the most-flagged hardening from the rev-2
 * multi-model plan review.
 *
 * Two implementations:
 *   - InMemorySeenStore: for tests + single-process dev. NOT for production.
 *   - RedisSeenStore: backed by Upstash Redis (or any Redis-compatible
 *     SET NX EX implementation). The production path.
 *
 * Callers select via NewSeenStore(opts) based on env. The contract is the
 * same: first call with a given key wins; subsequent calls within TTL
 * return the original task_id and the caller MUST reject with 409 CONFLICT.
 */

/** Result of a check-and-set against the replay store. */
export type SeenResult =
  | { firstTime: true }
  | { firstTime: false; existingTaskId: string };

/**
 * Replay store contract. Implementations MUST be safe under concurrent
 * SeeOrFetch calls — exactly one caller for a given key gets firstTime=true.
 */
export interface SeenStore {
  /**
   * Atomically: if `key` has not been seen within TTL, record it with the
   * supplied taskId and return firstTime=true. Otherwise return
   * firstTime=false and the originally-recorded taskId.
   */
  seeOrFetch(key: string, taskId: string): Promise<SeenResult>;

  /** Maximum entry lifetime in milliseconds. */
  readonly ttlMs: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes — matches the A2A spec

/**
 * In-process implementation. Each entry expires lazily on lookup.
 * Hard cap on size prevents unbounded growth under attack.
 *
 * Safe under concurrent calls from the SAME process but NOT cross-process.
 * Use only in tests + single-instance dev runs.
 */
export class InMemorySeenStore implements SeenStore {
  readonly ttlMs: number;
  private readonly maxSize: number;
  private readonly map = new Map<
    string,
    { taskId: string; recordedAt: number }
  >();

  constructor(opts?: { ttlMs?: number; maxSize?: number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.maxSize = opts?.maxSize ?? 100_000;
  }

  async seeOrFetch(key: string, taskId: string): Promise<SeenResult> {
    const now = Date.now();
    const cutoff = now - this.ttlMs;

    // Passive expiry: evict any entry older than the TTL.
    for (const [k, v] of this.map) {
      if (v.recordedAt < cutoff) {
        this.map.delete(k);
      }
    }

    const existing = this.map.get(key);
    if (existing && existing.recordedAt >= cutoff) {
      return { firstTime: false, existingTaskId: existing.taskId };
    }

    // LRU eviction if we hit the cap.
    if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }

    this.map.set(key, { taskId, recordedAt: now });
    return { firstTime: true };
  }

  /** Test helper. Production code MUST NOT call this. */
  _clear(): void {
    this.map.clear();
  }
}

/**
 * Redis-backed implementation. Uses SET NX EX semantics so the first call
 * for a key wins atomically across processes/instances.
 *
 * Constructor takes a minimal redis-client adapter so we don't lock the
 * concrete library (ioredis vs @upstash/redis vs node-redis) at this layer.
 * Production wiring picks whichever the deployment uses.
 */
export interface MinimalRedisClient {
  /**
   * SET key value [NX] [EX seconds] — returns the previous value when NX
   * fails, or undefined/null when NX succeeds (key did not exist).
   *
   * Semantically:
   *   - On success (firstTime): returns ok-marker (e.g. "OK")
   *   - On NX fail: returns null
   * Implementations MUST use atomic SET NX EX; emulating via GET+SET is unsafe.
   */
  setNxEx(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<string | null>;

  /** Read the value for a key (used to fetch the original taskId on conflict). */
  get(key: string): Promise<string | null>;
}

export class RedisSeenStore implements SeenStore {
  readonly ttlMs: number;
  private readonly client: MinimalRedisClient;
  private readonly prefix: string;

  constructor(
    client: MinimalRedisClient,
    opts?: { ttlMs?: number; prefix?: string },
  ) {
    this.client = client;
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.prefix = opts?.prefix ?? "a2a:seen:";
  }

  async seeOrFetch(key: string, taskId: string): Promise<SeenResult> {
    const fullKey = this.prefix + key;
    const ttlSeconds = Math.max(1, Math.floor(this.ttlMs / 1000));
    const result = await this.client.setNxEx(fullKey, taskId, ttlSeconds);
    if (result !== null) {
      return { firstTime: true };
    }
    // SET NX failed → key already exists. Fetch the recorded taskId.
    const existing = await this.client.get(fullKey);
    return {
      firstTime: false,
      // If the key disappears between SETNX and GET (TTL boundary race),
      // we still report a conflict but the existingTaskId is unknown.
      existingTaskId: existing ?? "<unknown>",
    };
  }
}
