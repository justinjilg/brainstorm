/**
 * Speculative Execution — try two approaches in parallel.
 *
 * Creates a git worktree per approach, runs each as a subagent,
 * compares results (which one builds? which is cleaner?),
 * and applies the winning changes.
 *
 * Uses git worktrees for isolation:
 *   git worktree add /tmp/brainstorm-spec-<id> -b spec-<id>
 *   ... run approach ...
 *   git worktree remove /tmp/brainstorm-spec-<id>
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export interface SpeculativeApproach {
  name: string;
  prompt: string;
}

export interface SpeculativeResult {
  name: string;
  worktreePath: string;
  buildPassed: boolean;
  filesChanged: string[];
  error?: string;
}

export interface SpeculativeOutcome {
  winner: SpeculativeResult | null;
  results: SpeculativeResult[];
  reason: string;
}

/** Create a git worktree for isolated execution. */
export function createWorktree(projectPath: string, name: string): string {
  const id = randomUUID().slice(0, 8);
  const worktreePath = join(tmpdir(), `brainstorm-spec-${id}`);
  const branchName = `spec-${id}`;

  try {
    execFileSync('git', ['worktree', 'add', worktreePath, '-b', branchName], {
      cwd: projectPath,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return worktreePath;
  } catch (err: any) {
    throw new Error(`Failed to create worktree for "${name}": ${err.message}`);
  }
}

/** Remove a git worktree and its branch. */
export function removeWorktree(projectPath: string, worktreePath: string): void {
  try {
    execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], {
      cwd: projectPath,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // Best effort cleanup
  }

  // Also clean up the spec branch
  const branchMatch = worktreePath.match(/spec-[a-f0-9]+/);
  if (branchMatch) {
    try {
      execFileSync('git', ['branch', '-D', branchMatch[0]], {
        cwd: projectPath,
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      // Branch may already be deleted
    }
  }
}

/** Check if a build passes in a worktree. */
export function checkBuild(worktreePath: string, buildCommand = 'npm run build'): boolean {
  try {
    execFileSync('/bin/sh', ['-c', buildCommand], {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/** Get list of changed files in a worktree relative to the base branch. */
export function getChangedFiles(worktreePath: string): string[] {
  try {
    const output = execFileSync('git', ['diff', '--name-only', 'HEAD~1'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** Compare two speculative results and pick the winner. */
export function pickWinner(results: SpeculativeResult[]): SpeculativeOutcome {
  const passing = results.filter((r) => r.buildPassed && !r.error);
  const failing = results.filter((r) => !r.buildPassed || r.error);

  if (passing.length === 0) {
    return { winner: null, results, reason: 'Neither approach builds successfully.' };
  }

  if (passing.length === 1) {
    return { winner: passing[0], results, reason: `"${passing[0].name}" is the only approach that builds.` };
  }

  // Both pass — prefer the one with fewer file changes (simpler)
  const sorted = passing.sort((a, b) => a.filesChanged.length - b.filesChanged.length);
  return {
    winner: sorted[0],
    results,
    reason: `Both approaches build. "${sorted[0].name}" is simpler (${sorted[0].filesChanged.length} vs ${sorted[1].filesChanged.length} files changed).`,
  };
}
