/**
 * Sync Worker — drains the SQLite sync queue by replaying requests
 * against BrainstormRouter with exponential backoff on failure.
 *
 * Architecture:
 *   1. Queue is in SQLite (see packages/db migration 030 + SyncQueueRepository)
 *   2. Callers enqueue fire-and-forget pushes via gateway client wrappers
 *      (rather than calling BR directly). If BR is reachable, the item
 *      flushes immediately; if not, it sits in the queue.
 *   3. SyncWorker.start() schedules periodic drain passes (default 15s)
 *   4. Each pass claims up to BATCH_SIZE pending rows, replays each, and
 *      marks completed/failed. markFailed schedules the next retry with
 *      jittered exponential backoff (5s → 1h cap, 10 attempts default).
 *   5. Idempotency: every queue row has a stable client-generated key that
 *      travels in the X-Idempotency-Key header. BR deduplicates on its
 *      side so retrying a request that already succeeded upstream is safe.
 *
 * Silent failure: if no gateway is configured (BRAINSTORM_API_KEY unset),
 * the worker is a no-op. Nothing gets drained, nothing gets pushed — but
 * the queue accumulates rows, which is fine; they'll drain next time the
 * user provides credentials.
 */

import { createLogger } from "@brainst0rm/shared";
import type { SyncQueueRepository, SyncQueueRow } from "@brainst0rm/db";
import type { BrainstormGateway } from "./client.js";

const log = createLogger("sync-worker");

export interface SyncWorkerOptions {
  /** Gateway client to use for the actual HTTP calls. */
  gateway: BrainstormGateway;
  /** Repository backing the queue. */
  repo: SyncQueueRepository;
  /** How often to run a drain pass (ms). Default 15s. */
  intervalMs?: number;
  /** Max rows processed per pass. Default 20. */
  batchSize?: number;
}

export interface SyncWorkerStats {
  passesRun: number;
  itemsProcessed: number;
  itemsSucceeded: number;
  itemsFailed: number;
  lastPassAt: number | null;
  lastError: string | null;
}

export class SyncWorker {
  private gateway: BrainstormGateway;
  private repo: SyncQueueRepository;
  private intervalMs: number;
  private batchSize: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  private stats: SyncWorkerStats = {
    passesRun: 0,
    itemsProcessed: 0,
    itemsSucceeded: 0,
    itemsFailed: 0,
    lastPassAt: null,
    lastError: null,
  };

  constructor(options: SyncWorkerOptions) {
    this.gateway = options.gateway;
    this.repo = options.repo;
    this.intervalMs = options.intervalMs ?? 15_000;
    this.batchSize = options.batchSize ?? 20;
  }

  /**
   * Start the periodic drain loop. Safe to call multiple times — idempotent.
   * The first drain runs immediately, subsequent drains on the interval.
   */
  start(): void {
    if (this.timer) return;
    // First drain: delay 1s so the caller has time to finish initialization
    // (e.g., the chat command sets up the gateway then starts the worker).
    this.timer = setTimeout(() => this.scheduleNext(), 1000);
  }

  /** Stop the worker. Any in-flight drain continues to completion. */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run a single drain pass synchronously. Used for tests and for the
   * `brainstorm sync flush` CLI command that drains on demand.
   */
  async drainOnce(): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
  }> {
    if (this.running) return { processed: 0, succeeded: 0, failed: 0 };
    this.running = true;
    this.stats.passesRun++;
    this.stats.lastPassAt = Math.floor(Date.now() / 1000);

    let succeeded = 0;
    let failed = 0;

    try {
      const batch = this.repo.claimBatch(this.batchSize);
      if (batch.length === 0) {
        this.running = false;
        return { processed: 0, succeeded: 0, failed: 0 };
      }

      for (const row of batch) {
        try {
          await this.sendRow(row);
          this.repo.markCompleted(row.id);
          succeeded++;
        } catch (err: any) {
          const errorMsg = err?.message ?? String(err);
          this.repo.markFailed(row.id, errorMsg);
          failed++;
          this.stats.lastError = errorMsg;
          // Don't log every failure — noisy. Log first failure per batch.
          if (failed === 1) {
            log.warn(
              { err: errorMsg, kind: row.kind, path: row.path },
              "sync item failed — retry scheduled",
            );
          }
        }
      }

      this.stats.itemsProcessed += batch.length;
      this.stats.itemsSucceeded += succeeded;
      this.stats.itemsFailed += failed;
    } finally {
      this.running = false;
    }

    return { processed: succeeded + failed, succeeded, failed };
  }

  /** Stats snapshot for the `brainstorm sync status` CLI command. */
  getStats(): SyncWorkerStats {
    return { ...this.stats };
  }

  private scheduleNext(): void {
    this.drainOnce()
      .catch((e) => {
        log.error({ err: e }, "sync-worker drain crashed");
      })
      .finally(() => {
        if (this.timer !== null) {
          // Still running — schedule next pass
          this.timer = setTimeout(() => this.scheduleNext(), this.intervalMs);
        }
      });
  }

  private async sendRow(row: SyncQueueRow): Promise<void> {
    const body = row.body ? JSON.parse(row.body) : undefined;
    await this.gateway.requestRaw(
      row.method,
      row.path,
      body,
      row.idempotencyKey,
    );
  }
}
