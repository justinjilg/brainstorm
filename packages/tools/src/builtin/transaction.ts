import { z } from "zod";
import { defineTool } from "../base.js";
import { readFileSync, existsSync } from "node:fs";
import { relative, resolve } from "node:path";

/**
 * Transaction Tool Calls — atomic multi-file edits.
 *
 * Between begin and commit, all file writes are tracked.
 * On rollback, all changes are reverted using checkpoint snapshots.
 * On commit, changes are finalized (already written to disk by file tools).
 *
 * This uses the existing CheckpointManager for rollback capability.
 */

let transactionActive = false;
let transactionFiles: string[] = [];

export function isTransactionActive(): boolean {
  return transactionActive;
}

export function getTransactionFiles(): string[] {
  return [...transactionFiles];
}

export function recordTransactionFile(path: string): void {
  if (transactionActive && !transactionFiles.includes(path)) {
    transactionFiles.push(path);
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
    if (transactionActive) {
      return { error: "Transaction already active. Commit or rollback first." };
    }
    transactionActive = true;
    transactionFiles = [];
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
    if (!transactionActive) {
      return { error: "No active transaction to commit." };
    }
    const files = [...transactionFiles];
    transactionActive = false;
    transactionFiles = [];
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
    if (!transactionActive) {
      return { error: "No active transaction to rollback." };
    }

    const { getCheckpointManager } = await import("../checkpoint.js");
    const cp = getCheckpointManager();
    const reverted: string[] = [];

    const failed: Array<{ file: string; error: string }> = [];

    // Order files by dependencies: dependents first, then dependencies
    const ordered = orderByDependencies(transactionFiles);

    if (cp) {
      // Revert dependents before dependencies to maintain consistency
      for (const file of ordered) {
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
      for (const file of transactionFiles) {
        failed.push({ file, error: "CheckpointManager not initialized" });
      }
    }

    transactionActive = false;
    transactionFiles = [];

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
