import {
  CustomerAccountDriftDetector,
  StaleArtifactDetector,
  IndexDriftDetector,
} from "@brainst0rm/harness-drift";
import {
  walkHarnessDirStat,
  readArtifactDeep,
  extractIndexFields,
} from "@brainst0rm/harness-fs";
import { HarnessIndexStore } from "@brainst0rm/harness-index";

/**
 * Harness loop runner — runs three periodic detectors against the active
 * harness session: indexer (re-walk + upsert + prune), customer-drift
 * detector, and stale-artifact watchdog.
 *
 * Plan item 7. Cadences default per the spec's Performance budgets section
 * but are tunable via the constructor. Each tick emits a `LoopEvent` to the
 * provided sink so the desktop can render a live event stream.
 */

export type LoopName = "indexer" | "customer-drift" | "stale-watchdog";

export interface LoopEvent {
  loop: LoopName;
  status: "started" | "completed" | "failed";
  at: number;
  /** Run-specific summary; shape varies by loop. */
  summary?: Record<string, unknown>;
  error?: string;
}

export interface LoopRunnerOptions {
  /** Harness root (the directory containing business.toml). */
  harnessRoot: string;
  /** SQLite index store for the active session. */
  index: HarnessIndexStore;
  /** Cadence in milliseconds per loop. Defaults below if not provided. */
  cadenceMs?: Partial<Record<LoopName, number>>;
  /** Optional event sink — desktop subscribes here for live updates. */
  onEvent?: (event: LoopEvent) => void;
  /** Override Date.now (testing). */
  now?: () => number;
  /** Run on construction or wait for start()? Defaults to false. */
  autoStart?: boolean;
}

const DEFAULT_CADENCE_MS: Record<LoopName, number> = {
  // Indexer is now stat-diff first, deep-read only on change — but keep a
  // conservative default since most cycles have no work to do anyway.
  indexer: 15 * 60 * 1000, // 15 min
  "customer-drift": 15 * 60 * 1000, // 15 min — more expensive
  "stale-watchdog": 60 * 60 * 1000, // 1 hr — review SLAs are daily-coarse
};

export class HarnessLoopRunner {
  private timers: Partial<Record<LoopName, NodeJS.Timeout>> = {};
  private running = false;
  private readonly cadence: Record<LoopName, number>;
  private readonly now: () => number;

  constructor(private readonly opts: LoopRunnerOptions) {
    this.cadence = {
      ...DEFAULT_CADENCE_MS,
      ...(opts.cadenceMs ?? {}),
    };
    this.now = opts.now ?? Date.now;
    if (opts.autoStart) this.start();
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // Schedule each loop on its own interval. Each fires immediately so the
    // first state is fresh, then settles into the cadence.
    for (const loop of [
      "indexer",
      "customer-drift",
      "stale-watchdog",
    ] as const) {
      void this.runOnce(loop);
      this.timers[loop] = setInterval(() => {
        void this.runOnce(loop);
      }, this.cadence[loop]);
      // Don't keep the process alive solely for these loops.
      this.timers[loop]?.unref?.();
    }
  }

  stop(): void {
    this.running = false;
    for (const loop of Object.keys(this.timers) as LoopName[]) {
      const t = this.timers[loop];
      if (t) clearInterval(t);
      delete this.timers[loop];
    }
  }

  /** Manually trigger one cycle of one loop. Useful for tests + UI buttons. */
  async runOnce(loop: LoopName): Promise<LoopEvent> {
    const startedAt = this.now();
    this.emit({ loop, status: "started", at: startedAt });
    try {
      const summary = await this.runLoop(loop);
      const event: LoopEvent = {
        loop,
        status: "completed",
        at: this.now(),
        summary,
      };
      this.emit(event);
      return event;
    } catch (e) {
      const event: LoopEvent = {
        loop,
        status: "failed",
        at: this.now(),
        error: e instanceof Error ? e.message : String(e),
      };
      this.emit(event);
      return event;
    }
  }

  private emit(event: LoopEvent): void {
    this.opts.onEvent?.(event);
  }

  private async runLoop(loop: LoopName): Promise<Record<string, unknown>> {
    switch (loop) {
      case "indexer":
        return this.runIndexer();
      case "customer-drift":
        return this.runCustomerDrift();
      case "stale-watchdog":
        return this.runStaleWatchdog();
    }
  }

  private async runIndexer(): Promise<Record<string, unknown>> {
    // Stat-only walk — no readFileSync, no hashing, no TOML parse. Cheap
    // even on huge harness trees because it's bounded by file count, not
    // file content size.
    const walk = walkHarnessDirStat(this.opts.harnessRoot);

    // Build a baseline from the existing index so we can skip files whose
    // (mtime_ms, size_bytes) haven't drifted since last cycle.
    const baseline = new Map<
      string,
      { mtime_ms: number; size_bytes: number }
    >();
    for (const row of this.opts.index.allArtifacts()) {
      baseline.set(row.relative_path, {
        mtime_ms: row.mtime_ms,
        size_bytes: row.size_bytes,
      });
    }

    const seen = new Set<string>();
    let upserts = 0;
    let unchanged = 0;
    for (const stat of walk.artifacts) {
      seen.add(stat.relativePath);
      const prior = baseline.get(stat.relativePath);
      // Same mtime + size => content unchanged; index row is still valid.
      // (The Math.floor matches coldOpenVerify's tolerance for fs mtime
      // resolution drift.)
      if (
        prior !== undefined &&
        prior.size_bytes === stat.size_bytes &&
        Math.floor(prior.mtime_ms) === Math.floor(stat.mtime_ms)
      ) {
        unchanged++;
        continue;
      }

      const artifact = readArtifactDeep(stat);
      if (artifact === null) continue;

      const fields = extractIndexFields(artifact.frontmatter);
      this.opts.index.upsertArtifact({
        relative_path: artifact.relativePath,
        mtime_ms: artifact.mtime_ms,
        size_bytes: artifact.size_bytes,
        content_hash: artifact.content_hash,
        artifact_kind: detectKindFallback(
          artifact.relativePath,
          artifact.frontmatter,
        ),
        owner: fields.owner,
        status: fields.status,
        reviewed_at: fields.reviewed_at,
        tags: fields.tags,
        references: fields.references,
      });
      upserts++;
    }

    let pruned = 0;
    for (const relPath of baseline.keys()) {
      if (!seen.has(relPath)) {
        this.opts.index.removeArtifact(relPath);
        pruned++;
      }
    }

    return {
      walked: walk.artifacts.length,
      upserts,
      unchanged,
      pruned,
      duration_ms: walk.duration_ms,
    };
  }

  private async runCustomerDrift(): Promise<Record<string, unknown>> {
    const detector = new CustomerAccountDriftDetector(this.opts.harnessRoot);
    const drifts = await detector.detect();
    const unobserved = detector.unobservedAccounts();
    // Persist drifts to the index's drift_state table so the desktop can
    // surface "open drifts since last reconciliation" without re-running
    // the detector on every render.
    for (const d of drifts) {
      this.opts.index.recordDrift({
        id: d.id,
        field_class: d.field_class,
        relative_path: d.relative_path,
        field_path: d.field_path,
        intent_value: d.intent_value,
        observed_value: d.observed_value,
        detector_name: d.detector_name,
        severity: d.severity,
      });
    }
    return {
      drifts_open: drifts.length,
      accounts_unobserved: unobserved.length,
    };
  }

  private async runStaleWatchdog(): Promise<Record<string, unknown>> {
    const detector = new StaleArtifactDetector(this.opts.index, {
      now: this.now,
    });
    const drifts = await detector.detect();
    return {
      stale_artifacts: drifts.length,
      by_severity: drifts.reduce<Record<string, number>>((acc, d) => {
        acc[d.severity] = (acc[d.severity] ?? 0) + 1;
        return acc;
      }, {}),
    };
  }
}

/**
 * Mirrors detectKind() in @brainst0rm/harness-fs without depending on it
 * directly (the export isn't part of the public surface yet).
 */
function detectKindFallback(
  relativePath: string,
  frontmatter: Record<string, unknown> | null,
): string {
  if (relativePath === "business.toml") return "manifest";
  if (relativePath.endsWith(".age") || relativePath.endsWith(".sops.toml"))
    return "encrypted";
  if (frontmatter?.id && typeof frontmatter.id === "string") {
    const id = frontmatter.id;
    if (id.startsWith("party_")) return "party";
    if (id.startsWith("acct_")) return "account";
    if (id.startsWith("prod_")) return "product";
    if (id.startsWith("person_")) return "human";
    if (id.startsWith("agent_")) return "agent";
    if (id.startsWith("dec_")) return "decision";
  }
  return "other";
}

// Re-export IndexDriftDetector for callers that want to compose their own
// loops without picking up the full runner.
export { IndexDriftDetector };
