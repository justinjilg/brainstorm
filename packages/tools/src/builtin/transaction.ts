import { z } from 'zod';
import { defineTool } from '../base.js';
import { mkdirSync, copyFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

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
  name: 'begin_transaction',
  description: 'Start an atomic transaction for multi-file edits. All file writes between begin and commit/rollback are tracked. On rollback, all changes revert. Use for coordinated multi-file changes where partial application would break the build.',
  permission: 'auto',
  inputSchema: z.object({
    description: z.string().optional().describe('What this transaction is for'),
  }),
  async execute({ description }) {
    if (transactionActive) {
      return { error: 'Transaction already active. Commit or rollback first.' };
    }
    transactionActive = true;
    transactionFiles = [];
    return {
      success: true,
      message: `Transaction started.${description ? ` Purpose: ${description}` : ''} All file writes are now tracked. Use commit_transaction to finalize or rollback_transaction to revert.`,
    };
  },
});

export const commitTransactionTool = defineTool({
  name: 'commit_transaction',
  description: 'Finalize a transaction. All file writes since begin_transaction are kept. Returns the list of files modified.',
  permission: 'auto',
  inputSchema: z.object({}),
  async execute() {
    if (!transactionActive) {
      return { error: 'No active transaction to commit.' };
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
  name: 'rollback_transaction',
  description: 'Rollback a transaction. All file writes since begin_transaction are reverted using checkpoint snapshots. Returns the list of files reverted.',
  permission: 'confirm',
  inputSchema: z.object({
    reason: z.string().optional().describe('Why the rollback is needed'),
  }),
  async execute({ reason }) {
    if (!transactionActive) {
      return { error: 'No active transaction to rollback.' };
    }

    const { getCheckpointManager } = await import('../checkpoint.js');
    const cp = getCheckpointManager();
    const reverted: string[] = [];

    const failed: Array<{ file: string; error: string }> = [];

    if (cp) {
      // Revert files in reverse order (last written first)
      for (const file of [...transactionFiles].reverse()) {
        try {
          const result = cp.revertLast(file);
          if (result) {
            reverted.push(result);
          } else {
            failed.push({ file, error: 'No checkpoint snapshot available' });
          }
        } catch (e: any) {
          failed.push({ file, error: e.message ?? String(e) });
        }
      }
    } else {
      // No checkpoint manager — all files fail
      for (const file of transactionFiles) {
        failed.push({ file, error: 'CheckpointManager not initialized' });
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
