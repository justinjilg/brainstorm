/**
 * Diff Preview — get a compact git diff summary after file writes.
 * Non-blocking, fails silently if not in a git repo.
 */

import { execFileSync } from 'node:child_process';

export interface DiffSummary {
  additions: number;
  deletions: number;
  preview: string;
}

/** Get a compact diff summary for a file. Returns null if not in git or no changes. */
export function getDiffSummary(filePath: string): DiffSummary | null {
  try {
    const stat = execFileSync('git', ['diff', '--numstat', '--', filePath], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    if (!stat) return null;

    const [add, del] = stat.split('\t');
    const additions = parseInt(add, 10) || 0;
    const deletions = parseInt(del, 10) || 0;

    if (additions === 0 && deletions === 0) return null;

    return {
      additions,
      deletions,
      preview: `+${additions} -${deletions} lines`,
    };
  } catch {
    return null; // Not in git, or git not available
  }
}
