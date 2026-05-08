import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteFile } from "@brainst0rm/shared";

/**
 * Write-ahead log for harness filesystem operations.
 *
 * Per spec `## Index Coherence and Drift Architecture` invariant #3:
 * "Before any FS write, append `{path, intent}` to `.harness/index/wal.log`.
 *  After successful index update, mark that line as completed. On startup,
 *  replay incomplete entries."
 *
 * The WAL is a JSONL file, append-only. Each entry is one of:
 *   { kind: "begin", id, path, intent_hash, at }
 *   { kind: "commit", id, at }
 *   { kind: "abort", id, error, at }
 *
 * Replay: scan the log, find `begin` entries with no matching `commit`
 * or `abort`, and re-issue the index update (the file write itself was
 * either atomic-completed or atomic-not-yet-started — `atomicWriteFile`
 * is the source of truth for the file).
 */

export type WalEntry =
  | {
      kind: "begin";
      id: string;
      path: string;
      intent_hash: string;
      at: number;
    }
  | { kind: "commit"; id: string; at: number }
  | { kind: "abort"; id: string; error: string; at: number };

export class WriteAheadLog {
  constructor(private readonly logPath: string) {
    const dir = dirname(logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  /** Append a single entry. Synchronous + fsync-safe via O_APPEND. */
  append(entry: WalEntry): void {
    appendFileSync(this.logPath, JSON.stringify(entry) + "\n", {
      encoding: "utf-8",
      flag: "a",
    });
  }

  /** Replay all entries; returns ids that began but did not commit/abort. */
  pendingIds(): Array<{ id: string; path: string; intent_hash: string }> {
    if (!existsSync(this.logPath)) return [];
    const content = readFileSync(this.logPath, "utf-8");
    const seen = new Map<
      string,
      { begin?: WalEntry & { kind: "begin" }; finalized: boolean }
    >();
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: WalEntry;
      try {
        entry = JSON.parse(trimmed) as WalEntry;
      } catch {
        continue;
      }
      const existing = seen.get(entry.id) ?? { finalized: false };
      if (entry.kind === "begin") existing.begin = entry;
      if (entry.kind === "commit" || entry.kind === "abort") {
        existing.finalized = true;
      }
      seen.set(entry.id, existing);
    }

    const pending: Array<{ id: string; path: string; intent_hash: string }> =
      [];
    for (const [id, state] of seen) {
      if (state.begin && !state.finalized) {
        pending.push({
          id,
          path: state.begin.path,
          intent_hash: state.begin.intent_hash,
        });
      }
    }
    return pending;
  }

  /**
   * Compact the log by rewriting only the unfinalized entries. Recommended
   * after each successful cold-open replay so the log doesn't grow unbounded.
   */
  compact(): void {
    const pending = this.pendingIds();
    const lines = pending.map((p) =>
      JSON.stringify({
        kind: "begin",
        id: p.id,
        path: p.path,
        intent_hash: p.intent_hash,
        at: Date.now(),
      } satisfies WalEntry),
    );
    atomicWriteFile(this.logPath, lines.length ? lines.join("\n") + "\n" : "");
  }
}
