import { z } from "zod";
import { defineTool } from "../base.js";
import { readFileSync, existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { getSessionId } from "../session-context.js";

/**
 * Transaction Tool Calls — atomic multi-file edits.
 *
 * Between begin and commit, all file writes are tracked.
 * On rollback, all changes are reverted using checkpoint snapshots.
 * On commit, changes are finalized (already written to disk by file tools).
 *
 * This uses the existing CheckpointManager for rollback capability.
 *
 * Per-session: a single module-global `transactionActive` flag meant two
 * concurrent runs corrupted each other's transactions (one committing while
 * the other tracked files). Keyed by the current session id instead.
 */

interface TxState {
  active: boolean;
  /**
   * Tracked files → the content hash at the transaction's last write. Rollback
   * refuses to revert a file whose current content no longer matches, so a
   * concurrent session that edited the same file afterward isn't silently
   * clobbered (the safety gap that per-session — hence concurrent —
   * transactions introduced over the old single-global-flag serialization).
   */
  files: Map<string, string>;
}
const MAX_TRACKED_SESSIONS = 256;
const txStates = new Map<string, TxState>();

function hashFile(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null; // unreadable/absent — recorded as "no hash"
  }
}

/** Read-only peek: never allocates a state entry. */
function peekTx(sessionId: string): TxState | undefined {
  return txStates.get(sessionId);
}

/** Get-or-create for the ACTIVE (begin) path. Never evicts an active tx. */
function beginTxState(sessionId: string): TxState {
  let s = txStates.get(sessionId);
  if (!s) {
    if (txStates.size >= MAX_TRACKED_SESSIONS) {
      for (const [id, st] of txStates) {
        if (!st.active) {
          txStates.delete(id);
          break;
        }
      }
    }
    s = { active: false, files: new Map() };
    txStates.set(sessionId, s);
  }
  return s;
}

export function isTransactionActive(): boolean {
  return peekTx(getSessionId())?.active ?? false;
}

export function getTransactionFiles(): string[] {
  return [...(peekTx(getSessionId())?.files.keys() ?? [])];
}

export function recordTransactionFile(path: string): void {
  const s = peekTx(getSessionId());
  if (s?.active) {
    // Record the hash AS WRITTEN so rollback can detect later divergence.
    s.files.set(path, hashFile(path) ?? "");
  }
}

export const beginTransactionTool = defineTool({
  name: "begin_transaction",
  description:
    "Start an atomic transaction for multi-file edits. All file writes between begin and commit/rollback are tracked. On rollback, all changes revert. Use for coordinated multi-file changes where partial application would break the build.",
  permission: "auto",
  inputSchema: z.object({
    description: z.string().optional().describe("What this transaction is for"),
  }),
  async execute({ description }) {
    const s = beginTxState(getSessionId());
    if (s.active) {
      return { error: "Transaction already active. Commit or rollback first." };
    }
    s.active = true;
    s.files = new Map();
    return {
      success: true,
      message: `Transaction started.${description ? ` Purpose: ${description}` : ""} All file writes are now tracked. Use commit_transaction to finalize or rollback_transaction to revert.`,
    };
  },
});

export const commitTransactionTool = defineTool({
  name: "commit_transaction",
  description:
    "Finalize a transaction. All file writes since begin_transaction are kept. Returns the list of files modified.",
  permission: "auto",
  inputSchema: z.object({}),
  async execute() {
    const sessionId = getSessionId();
    const s = peekTx(sessionId);
    if (!s?.active) {
      return { error: "No active transaction to commit." };
    }
    const files = [...s.files.keys()];
    // Release the state entirely on commit (no lingering inactive entry).
    txStates.delete(sessionId);
    return {
      success: true,
      filesCommitted: files,
      count: files.length,
    };
  },
});

export const rollbackTransactionTool = defineTool({
  name: "rollback_transaction",
  description:
    "Rollback a transaction. All file writes since begin_transaction are reverted using checkpoint snapshots. Returns the list of files reverted.",
  permission: "confirm",
  inputSchema: z.object({
    reason: z.string().optional().describe("Why the rollback is needed"),
  }),
  async execute({ reason }) {
    const sessionId = getSessionId();
    const s = peekTx(sessionId);
    if (!s?.active) {
      return { error: "No active transaction to rollback." };
    }

    const { getCheckpointManager } = await import("../checkpoint.js");
    const cp = getCheckpointManager();
    const reverted: string[] = [];

    const failed: Array<{ file: string; error: string }> = [];

    // Order files by dependencies: dependents first, then dependencies
    const ordered = orderByDependencies([...s.files.keys()]);

    if (cp) {
      // Revert dependents before dependencies to maintain consistency
      for (const file of ordered) {
        // Safety: if the file diverged from what THIS transaction last wrote
        // (a concurrent session edited it since), refuse to revert — reverting
        // to our older snapshot would silently clobber the other session's
        // work. "" recorded-hash means the file was unreadable at record time.
        const recordedHash = s.files.get(file) ?? "";
        if (recordedHash) {
          const currentHash = hashFile(file);
          if (currentHash !== null && currentHash !== recordedHash) {
            failed.push({
              file,
              error:
                "File changed since this transaction's last write (concurrent edit) — rollback refused to avoid clobbering it",
            });
            continue;
          }
        }
        try {
          const result = cp.revertLast(file);
          if (result) {
            reverted.push(result);
          } else {
            failed.push({ file, error: "No checkpoint snapshot available" });
          }
        } catch (e: any) {
          failed.push({ file, error: e.message ?? String(e) });
        }
      }
    } else {
      // No checkpoint manager — all files fail
      for (const file of s.files.keys()) {
        failed.push({ file, error: "CheckpointManager not initialized" });
      }
    }

    // Release the transaction state on rollback.
    txStates.delete(sessionId);

    const partialRollback = failed.length > 0 && reverted.length > 0;

    return {
      success: failed.length === 0,
      filesReverted: reverted,
      filesFailed: failed,
      count: reverted.length,
      total: reverted.length + failed.length,
      partialRollback,
      reason,
    };
  },
});

/**
 * Order files so dependents come before dependencies.
 * Parses import statements to build a dependency graph
 * among the transaction files, then topologically sorts (dependents first).
 */
function orderByDependencies(files: string[]): string[] {
  if (files.length <= 1) return [...files];

  const fileSet = new Set(files.map((f) => resolve(f)));
  const imports = new Map<string, Set<string>>();

  for (const file of fileSet) {
    const deps = new Set<string>();
    try {
      if (existsSync(file)) {
        const content = readFileSync(file, "utf-8");
        const importPattern = /(?:from|import)\s+['"](\.[^'"]+)['"]/g;
        let match;
        while ((match = importPattern.exec(content)) !== null) {
          const importPath = match[1];
          const dir = file.replace(/[/\\][^/\\]+$/, "");
          for (const ext of ["", ".ts", ".js", ".tsx", ".jsx"]) {
            const resolved = resolve(dir, importPath + ext);
            if (fileSet.has(resolved)) {
              deps.add(resolved);
              break;
            }
          }
        }
      }
    } catch {
      // Can't read file — skip dependency analysis
    }
    imports.set(file, deps);
  }

  // Topological sort: dependents first (reverse post-order)
  const visited = new Set<string>();
  const result: string[] = [];

  function visit(file: string): void {
    if (visited.has(file)) return;
    visited.add(file);
    const deps = imports.get(file);
    if (deps) {
      for (const dep of deps) visit(dep);
    }
    result.push(file);
  }

  for (const file of fileSet) visit(file);
  result.reverse();

  const resolvedToOriginal = new Map<string, string>();
  for (const f of files) resolvedToOriginal.set(resolve(f), f);
  return result.map((f) => resolvedToOriginal.get(f) ?? f);
}
