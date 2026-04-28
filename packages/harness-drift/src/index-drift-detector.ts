import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { hashContent } from "@brainst0rm/harness-fs";
import type { HarnessIndexStore } from "@brainst0rm/harness-index";
import type {
  Drift,
  DriftDetector,
  ChangeSet,
  ChangeSetSimulation,
  ChangeSetResult,
} from "./types.js";

/**
 * Index-class drift detector — verifies that each indexed entry's
 * (mtime, size, content_hash) triple still matches the file on disk.
 *
 * Per Decision #9: index-class drifts NEVER surface in user-facing panels.
 * The desktop runs `IndexDriftDetector.detect()` quietly on harness open
 * and after watcher events, then auto-applies `RebuildIndexEntryChangeSet`
 * for each result. Users only learn about index drift via debug logs.
 *
 * The detector returns idempotent ids — re-running with the same FS state
 * produces the same id list — so the desktop can safely de-dupe and avoid
 * spamming repeat work.
 */
export class IndexDriftDetector implements DriftDetector {
  readonly name = "index-drift";
  readonly field_class = "index" as const;

  constructor(
    private readonly harnessRoot: string,
    private readonly index: HarnessIndexStore,
  ) {}

  detect(): Drift[] {
    const drifts: Drift[] = [];
    const rows = this.index.allArtifacts();
    const now = Date.now();

    for (const row of rows) {
      const abs = join(this.harnessRoot, row.relative_path);
      if (!existsSync(abs)) {
        drifts.push({
          id: stableId("missing", row.relative_path),
          field_class: "index",
          relative_path: row.relative_path,
          field_path: "*",
          intent_value: row.content_hash,
          observed_value: null,
          detector_name: this.name,
          detected_at: now,
          severity: "informational",
        });
        continue;
      }
      const stats = statSync(abs);
      const mtimeChanged =
        Math.floor(stats.mtimeMs) !== Math.floor(row.mtime_ms);
      const sizeChanged = stats.size !== row.size_bytes;
      if (!mtimeChanged && !sizeChanged) continue;

      // Re-hash before flagging to handle metadata-only changes (cp -p).
      const observedHash = hashContent(readFileSync(abs));
      if (observedHash === row.content_hash) continue;

      drifts.push({
        id: stableId("stale", row.relative_path, observedHash),
        field_class: "index",
        relative_path: row.relative_path,
        field_path: "*",
        intent_value: row.content_hash,
        observed_value: observedHash,
        detector_name: this.name,
        detected_at: now,
        severity: "informational",
      });
    }

    return drifts;
  }
}

/**
 * The corresponding ChangeSet for an index-class drift: rebuild the index
 * entry from the file. Always reversible (the prior index row can be
 * persisted before apply if the caller needs to revert; in practice we
 * don't because the FS is the source of truth).
 */
export class RebuildIndexEntryChangeSet implements ChangeSet {
  readonly id: string;
  readonly kind = "rebuild-index-entry" as const;
  readonly state: "proposed" | "applied" | "reverted" | "expired" = "proposed";
  readonly created_at = Date.now();
  readonly applied_at?: number;
  readonly reverted_at?: number;
  readonly payload: Record<string, unknown>;

  constructor(
    public readonly drift: Drift,
    public readonly actor_ref: string,
    private readonly harnessRoot: string,
    private readonly index: HarnessIndexStore,
    private readonly indexUpdater: (
      relativePath: string,
      content: Buffer,
    ) => void | Promise<void>,
  ) {
    this.id = randomUUID();
    this.payload = {
      relative_path: drift.relative_path,
      reason: drift.observed_value ? "stale" : "missing",
    };
  }

  simulate(): ChangeSetSimulation {
    return {
      description:
        this.drift.observed_value === null
          ? `Remove index entry for missing file ${this.drift.relative_path}`
          : `Re-index ${this.drift.relative_path} from disk (hash ${this.drift.intent_value?.slice(0, 8) ?? "?"} → ${this.drift.observed_value?.slice(0, 8) ?? "?"})`,
      diffs: [
        {
          target: this.drift.relative_path,
          field: "content_hash",
          from: this.drift.intent_value,
          to: this.drift.observed_value,
        },
      ],
      reversible: false, // index is purely derived; no need
    };
  }

  async apply(): Promise<ChangeSetResult> {
    const abs = join(this.harnessRoot, this.drift.relative_path);
    if (!existsSync(abs)) {
      this.index.removeArtifact(this.drift.relative_path);
      return {
        ok: true,
        message: `Removed missing entry`,
        effects: [
          {
            target: this.drift.relative_path,
            description: "removed from index",
          },
        ],
      };
    }
    const buf = readFileSync(abs);
    await this.indexUpdater(this.drift.relative_path, buf);
    return {
      ok: true,
      message: `Re-indexed`,
      effects: [
        { target: this.drift.relative_path, description: "re-indexed from FS" },
      ],
    };
  }

  revert(): ChangeSetResult {
    return {
      ok: false,
      message:
        "Index changes are not revertible — the FS is source of truth. Run a full reindex if needed.",
    };
  }
}

/** Stable id helper: same inputs → same id, no clock dependence. */
function stableId(...parts: string[]): string {
  return (
    "drift_" +
    createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16)
  );
}
