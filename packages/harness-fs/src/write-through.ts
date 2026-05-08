import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { mkdirSync, statSync, existsSync } from "node:fs";
import { atomicWriteFile } from "@brainst0rm/shared";
import { WriteAheadLog } from "./wal.js";

/**
 * Write-through API for the harness — the canonical mutation path for
 * any file under the harness root. Per spec `## Index Coherence` Decision
 * #8: every write goes through this so the index update is transactional
 * with the FS write.
 *
 * Order of operations (per spec invariant: rename happens *before* index
 * update):
 *   1. WAL.append({ kind: "begin", id, path, intent_hash })
 *   2. atomicWriteFile() — tempfile, fsync, rename
 *   3. caller updates the index using the returned WriteResult
 *   4. WAL.append({ kind: "commit", id }) — ONLY after index update succeeds
 *
 * Crash recovery: on startup, replay WAL pending ids. The file may already
 * be at intent_hash (atomic-write completed before crash) or not (atomic-
 * write hadn't started); either way the index update is the only thing to
 * re-issue. The hash verification in the index module decides what to do.
 */

export interface HarnessWrite {
  /** Path inside the harness, absolute. */
  absolutePath: string;
  /** Path relative to harness root (used as index key). */
  relativePath: string;
  /** Plaintext content (or buffer) being written. */
  content: string | Buffer;
}

export interface WriteResult {
  /** WAL transaction id. The caller must call `commit(id)` after their
   *  side-effect (index update) succeeds. */
  id: string;
  /** Path that was written. */
  path: string;
  /** Path relative to harness root. */
  relativePath: string;
  /** SHA-256 of the content that landed on disk. Source-of-truth for the
   *  index entry. */
  content_hash: string;
  /** Bytes written. */
  size: number;
  /** Timestamp from the FS after rename (mtime ms). */
  mtime_ms: number;
}

export class HarnessWriter {
  private readonly wal: WriteAheadLog;

  constructor(
    private readonly harnessRoot: string,
    walPath?: string,
  ) {
    this.wal = new WriteAheadLog(
      walPath ?? join(harnessRoot, ".harness", "index", "wal.log"),
    );
  }

  /**
   * Begin a write. Atomic-renames the file into place; appends a `begin`
   * WAL entry. Returns enough metadata for the caller to update its index.
   *
   * The caller MUST follow up with `commit(id)` (after index update) or
   * `abort(id, error)` (if the index update fails).
   */
  begin(write: HarnessWrite): WriteResult {
    const id = randomUUID();
    const intent_hash = sha256(write.content);

    this.wal.append({
      kind: "begin",
      id,
      path: write.absolutePath,
      intent_hash,
      at: Date.now(),
    });

    // Ensure parent dir exists; atomicWriteFile requires it
    const parent = dirname(write.absolutePath);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

    atomicWriteFile(write.absolutePath, write.content);

    const stats = statSync(write.absolutePath);

    return {
      id,
      path: write.absolutePath,
      relativePath: write.relativePath,
      content_hash: intent_hash,
      size: stats.size,
      mtime_ms: stats.mtimeMs,
    };
  }

  /** Mark the transaction complete. Called after index update succeeds. */
  commit(id: string): void {
    this.wal.append({ kind: "commit", id, at: Date.now() });
  }

  /** Mark the transaction aborted. Called when index update fails. */
  abort(id: string, error: string): void {
    this.wal.append({ kind: "abort", id, error, at: Date.now() });
  }

  /**
   * Convenience: open begin → run callback → commit/abort. Use when the
   * caller doesn't need to do anything between the FS write and the
   * commit (most common case).
   */
  async write(
    write: HarnessWrite,
    indexUpdate: (result: WriteResult) => void | Promise<void>,
  ): Promise<WriteResult> {
    const result = this.begin(write);
    try {
      await indexUpdate(result);
      this.commit(result.id);
      return result;
    } catch (e) {
      this.abort(result.id, e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  /** Compute path relative to harness root for index key generation. */
  relativize(absolutePath: string): string {
    return relative(this.harnessRoot, absolutePath);
  }

  /** Replay pending writes from the WAL after a crash. */
  pendingWrites(): Array<{ id: string; path: string; intent_hash: string }> {
    return this.wal.pendingIds();
  }

  /** Compact the WAL after replay. */
  compactWal(): void {
    this.wal.compact();
  }
}

function sha256(content: string | Buffer): string {
  return createHash("sha256")
    .update(
      typeof content === "string" ? Buffer.from(content, "utf-8") : content,
    )
    .digest("hex");
}

/** Standalone hashing helper exported for index callers. */
export function hashContent(content: string | Buffer): string {
  return sha256(content);
}
