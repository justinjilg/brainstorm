/**
 * Multi-Agent Judge — verifies the worker pool's output and decides whether
 * to merge worktree branches into the main project.
 *
 * Part of Transformation 2 from linked-crunching-hamming.md.
 *
 * The Judge runs after the worker pool finishes and:
 *   1. Detects file-level conflicts across worker worktrees (two tasks
 *      modified the same file → potential merge conflict).
 *   2. Runs build/test verification on each worktree to confirm the work
 *      compiles. Uses the project's package.json scripts where available.
 *   3. Produces a verdict per task and an overall decision:
 *        APPROVE: no conflicts + all builds pass → merge all worktrees
 *        REVISE: at least one task failed verification → spawn corrective
 *                tasks for the failed ones (out of scope for MVP — just reports)
 *        REJECT: irreconcilable conflicts → leave worktrees unmerged for human review
 *   4. On APPROVE, merges each worktree's branch into the current branch
 *      using git merge --squash so the resulting commit graph stays clean.
 *
 * The Judge is the safety gate that makes parallel multi-agent work
 * actually shippable instead of producing piles of worktrees nobody can
 * reconcile.
 */

import { OrchestrationTaskRepository } from "@brainst0rm/orchestrator";
import { createLogger } from "@brainst0rm/shared";
import type { OrchestrationTask } from "@brainst0rm/shared";
import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const log = createLogger("multi-agent-judge");

export interface JudgeVerdict {
  taskId: string;
  worktreePath: string;
  verified: boolean;
  buildPassed: boolean | null;
  testPassed: boolean | null;
  conflictingFiles: string[];
  notes: string;
}

export interface JudgeDecision {
  decision: "approve" | "revise" | "reject";
  verdicts: JudgeVerdict[];
  conflictMatrix: Record<string, string[]>;
  /** Tasks whose branches were successfully merged into the project. */
  mergedTaskIds: string[];
  /** Total elapsed time for the judge phase. */
  durationMs: number;
  reason: string;
}

export interface JudgeOptions {
  runId: string;
  db: Database.Database;
  projectPath: string;
  /** Skip per-worktree build verification — useful when builds are slow
   * or known to be flaky. Default false. */
  skipBuildVerify?: boolean;
  /** Auto-merge approved branches into the current project branch.
   * Default true — set to false to leave the worktrees unmerged for
   * human review. */
  autoMerge?: boolean;
}

/**
 * Run the Judge phase. Inspects every completed task, builds the conflict
 * matrix, runs verification, and returns a decision.
 */
export async function runJudge(options: JudgeOptions): Promise<JudgeDecision> {
  const {
    runId,
    db,
    projectPath,
    skipBuildVerify = false,
    autoMerge = true,
  } = options;
  const startedAt = Date.now();
  const taskRepo = new OrchestrationTaskRepository(db);

  const tasks = taskRepo.listByRun(runId);
  const completed = tasks.filter((t) => t.status === "completed");
  const failed = tasks.filter((t) => t.status === "failed");

  log.info(
    { runId, completed: completed.length, failed: failed.length },
    "Judge starting",
  );

  // ── Conflict matrix ────────────────────────────────────────────────
  // file → list of task IDs that touched it. Anything with > 1 entry is
  // a potential conflict.
  const fileToTasks = new Map<string, string[]>();
  for (const task of completed) {
    if (!task.filesTouched) continue;
    for (const file of task.filesTouched) {
      const list = fileToTasks.get(file) ?? [];
      list.push(task.id);
      fileToTasks.set(file, list);
    }
  }

  const conflictMatrix: Record<string, string[]> = {};
  for (const [file, taskIds] of fileToTasks) {
    if (taskIds.length > 1) {
      conflictMatrix[file] = taskIds;
    }
  }

  // ── Per-task verdict ───────────────────────────────────────────────
  const verdicts: JudgeVerdict[] = [];
  for (const task of completed) {
    if (!task.worktreePath) {
      verdicts.push({
        taskId: task.id,
        worktreePath: "",
        verified: false,
        buildPassed: null,
        testPassed: null,
        conflictingFiles: [],
        notes: "no worktree path recorded — cannot verify",
      });
      continue;
    }

    // Files in this task that overlap with another task's files.
    const conflictingFiles =
      task.filesTouched?.filter((f) => (conflictMatrix[f]?.length ?? 0) > 1) ??
      [];

    let buildPassed: boolean | null = null;
    let testPassed: boolean | null = null;
    let notes = "";

    if (!skipBuildVerify) {
      const result = verifyWorktree(task.worktreePath);
      buildPassed = result.buildPassed;
      testPassed = result.testPassed;
      notes = result.notes;
    } else {
      notes = "build verification skipped";
    }

    verdicts.push({
      taskId: task.id,
      worktreePath: task.worktreePath,
      verified: buildPassed !== false && testPassed !== false,
      buildPassed,
      testPassed,
      conflictingFiles,
      notes,
    });
  }

  // ── Overall decision ───────────────────────────────────────────────
  const hasConflicts = Object.keys(conflictMatrix).length > 0;
  const hasVerificationFailure = verdicts.some(
    (v) => v.buildPassed === false || v.testPassed === false,
  );
  const hasFailedTasks = failed.length > 0;

  let decision: "approve" | "revise" | "reject";
  let reason: string;
  if (hasConflicts) {
    decision = "reject";
    reason = `${Object.keys(conflictMatrix).length} files were modified by multiple workers — manual reconciliation required`;
  } else if (hasVerificationFailure) {
    decision = "revise";
    reason = `${verdicts.filter((v) => !v.verified).length} task(s) failed build/test verification`;
  } else if (hasFailedTasks) {
    decision = "revise";
    reason = `${failed.length} task(s) failed during execution`;
  } else if (verdicts.length === 0) {
    decision = "reject";
    reason = "no completed tasks to evaluate";
  } else {
    decision = "approve";
    reason = `all ${verdicts.length} tasks passed verification with no conflicts`;
  }

  // ── Auto-merge on approve ──────────────────────────────────────────
  const mergedTaskIds: string[] = [];
  if (decision === "approve" && autoMerge) {
    for (const verdict of verdicts) {
      if (!verdict.verified || !verdict.worktreePath) continue;
      try {
        mergeWorktreeBranch(projectPath, verdict.worktreePath);
        mergedTaskIds.push(verdict.taskId);
      } catch (err: any) {
        log.warn(
          { taskId: verdict.taskId, err: err.message },
          "Failed to merge worktree branch — leaving for manual review",
        );
        // Downgrade decision: a merge failure on an approved task means
        // we can't honor the approval.
        decision = "revise";
        reason = `verification passed but merge failed for task ${verdict.taskId}: ${err.message}`;
        break;
      }
    }
  }

  log.info(
    { runId, decision, mergedCount: mergedTaskIds.length },
    "Judge finished",
  );

  return {
    decision,
    verdicts,
    conflictMatrix,
    mergedTaskIds,
    durationMs: Date.now() - startedAt,
    reason,
  };
}

/**
 * Run the project's build + test scripts inside a worktree to verify the
 * worker's changes compile and pass existing tests.
 *
 * Strategy: read package.json from the worktree root, look for `build`
 * and `test` scripts, run them sequentially with a tight timeout. Buildable
 * non-test repos report buildPassed=true and testPassed=null.
 */
function verifyWorktree(worktreePath: string): {
  buildPassed: boolean | null;
  testPassed: boolean | null;
  notes: string;
} {
  const pkgPath = join(worktreePath, "package.json");
  if (!existsSync(pkgPath)) {
    return {
      buildPassed: null,
      testPassed: null,
      notes: "no package.json in worktree — verification skipped",
    };
  }

  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    scripts = pkg.scripts ?? {};
  } catch (err: any) {
    return {
      buildPassed: false,
      testPassed: null,
      notes: `failed to parse package.json: ${err.message}`,
    };
  }

  const notes: string[] = [];
  let buildPassed: boolean | null = null;
  let testPassed: boolean | null = null;

  if (scripts.build) {
    try {
      execFileSync("npm", ["run", "-s", "build"], {
        cwd: worktreePath,
        timeout: 5 * 60 * 1000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      buildPassed = true;
      notes.push("build:pass");
    } catch (err: any) {
      buildPassed = false;
      const stderr = err.stderr?.toString() ?? "";
      notes.push(`build:fail (${stderr.slice(-200)})`);
    }
  }

  if (scripts.test && buildPassed !== false) {
    try {
      execFileSync("npm", ["run", "-s", "test"], {
        cwd: worktreePath,
        timeout: 5 * 60 * 1000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      testPassed = true;
      notes.push("test:pass");
    } catch (err: any) {
      testPassed = false;
      const stderr = err.stderr?.toString() ?? "";
      notes.push(`test:fail (${stderr.slice(-200)})`);
    }
  }

  return {
    buildPassed,
    testPassed,
    notes: notes.join(" | ") || "no build/test scripts found",
  };
}

/**
 * Merge a worktree's branch into the current project branch using
 * `git merge --squash` so the result is a single commit per task.
 *
 * Throws on merge conflict — caller should catch and downgrade the
 * decision to revise.
 */
function mergeWorktreeBranch(projectPath: string, worktreePath: string): void {
  // Get the branch name from the worktree
  const branchName = execFileSync(
    "git",
    ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"],
    { encoding: "utf-8", timeout: 5000 },
  ).trim();

  if (!branchName || branchName === "HEAD") {
    throw new Error(`worktree at ${worktreePath} has no branch to merge`);
  }

  // Squash-merge into the project's current branch.
  execFileSync("git", ["merge", "--squash", branchName], {
    cwd: projectPath,
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Commit the squashed changes with a descriptive message.
  execFileSync(
    "git",
    ["commit", "-m", `multi-agent: merge worktree ${branchName.slice(0, 30)}`],
    {
      cwd: projectPath,
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

/**
 * Detect cross-worker file conflicts without running the full Judge.
 * Used by tests and the Planner's preview mode.
 */
export function detectConflicts(
  tasks: OrchestrationTask[],
): Record<string, string[]> {
  const fileToTasks = new Map<string, string[]>();
  for (const task of tasks) {
    if (task.status !== "completed" || !task.filesTouched) continue;
    for (const file of task.filesTouched) {
      const list = fileToTasks.get(file) ?? [];
      list.push(task.id);
      fileToTasks.set(file, list);
    }
  }

  const conflicts: Record<string, string[]> = {};
  for (const [file, taskIds] of fileToTasks) {
    if (taskIds.length > 1) {
      conflicts[file] = taskIds;
    }
  }
  return conflicts;
}
