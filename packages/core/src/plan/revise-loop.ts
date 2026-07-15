/**
 * Revise loop — the bounded merge-gate driver.
 *
 * Wraps the pool→gate sequence in a counted `for` loop so a panel `revise`
 * decision can drive a bounded number of automatic retry rounds instead of the
 * single print-and-exit today. It is STRICTLY OPT-IN: with `maxReviseIterations`
 * = 0 the loop body runs exactly once (one worker-pool pass + one merge gate),
 * which is byte-for-byte today's behavior — no re-enqueue, no rotation, no
 * contract mutation.
 *
 * Branching on the panel decision is exact:
 *   - approve → break; the merge already happened inside runMergeGate (autoMerge)
 *   - reject  → break; fail as today
 *   - revise  → if retries remain AND the run carries REAL per-task contracts,
 *               run one revise round (re-enqueue selected tasks under the SAME
 *               contract + corrective feedback + a rotated model, re-run the
 *               pool, re-gate); otherwise fall through to today's exit behavior.
 *
 * Termination is guaranteed three independent ways: the counter is bounded, each
 * revise round supersedes its originals (a finite, strictly-consumed set), and
 * approve/reject both break unconditionally.
 *
 * Extracted here (next to judge-panel.ts) so desktop/server paths can inherit
 * it later; the CLI is the first caller.
 */

import { OrchestrationTaskRepository } from "@brainst0rm/orchestrator";
import { ContractRepository } from "@brainst0rm/db";
import { scoreJudgeCapability } from "@brainst0rm/contracts";
import type {
  ModelEntry,
  OrchestrationTask,
  PanelConfig,
  PanelDecision,
  PriorAttemptFeedback,
  ReviewFinding,
} from "@brainst0rm/shared";
import { createLogger } from "@brainst0rm/shared";
import type { ProviderRegistry } from "@brainst0rm/providers";
import type Database from "better-sqlite3";
import type { SubagentOptions } from "../agent/subagent.js";
import { runMergeGate, type MergeGateResult } from "./judge-panel.js";
import {
  runWorkerPool,
  type WorkerPoolEvent,
} from "./multi-agent-worker-pool.js";

const log = createLogger("revise-loop");

/** Provenance/audit record for one re-enqueued retry task. */
export interface ReviseAttemptRecord {
  /** 1-based revise iteration this retry belongs to. */
  attempt: number;
  /** The superseded task row this retry replaces. */
  originalTaskId: string;
  /** The freshly created retry task row. */
  newTaskId: string;
  /** The contract carried forward (same id — never mutated). */
  contractId: string;
  /** The prior attempt's authoring model (contract.provenance.producerModelId). */
  failedModelId?: string;
  /** The model pinned onto the retry (rotated / degraded / pinned). */
  preferredModelId?: string;
  /** 'rotated:<id>' | 'degraded-same-model' | 'pinned-global-model'. */
  rotation: string;
}

export interface GateWithReviseOptions {
  runId: string;
  db: Database.Database;
  projectPath: string;
  /** The panel to run each gate against (e.g. DEFAULT_PANELS["merge-gate"]). */
  panel: PanelConfig;
  /** Base subagent options template (shared by pool + judge spawns). */
  subagentOptions: SubagentOptions;
  registry: ProviderRegistry;
  getModels: () => ModelEntry[];
  skipBuildVerify?: boolean;
  autoMerge?: boolean;
  /** Worker-pool concurrency. Default 3. */
  concurrency?: number;
  /**
   * Max revise rounds. 0 → the driver runs the pool once + gate once and
   * returns (pure passthrough, today's behavior). N → up to N automatic revise
   * rounds after the initial gate.
   */
  maxReviseIterations: number;
  /**
   * Set when the operator pinned a run-wide model (`--model`). Rotation is
   * DISABLED — the operator's explicit choice wins — and each retry pins this
   * model with `rotation: 'pinned-global-model'`.
   */
  pinnedModelId?: string;
  /** Forwarded worker-pool events (for CLI console rendering). `attempt` is the
   * loop iteration: 0 = initial pool run, N = the Nth revise round's pool. */
  onPoolEvent?: (event: WorkerPoolEvent, attempt: number) => void;
  /** Called after each gate with its result and iteration index. */
  onGate?: (result: MergeGateResult, attempt: number) => void;
  /** Called when a revise round re-enqueues retries. */
  onRevise?: (records: ReviseAttemptRecord[], attempt: number) => void;
  // ── Test seams ──────────────────────────────────────────────────────
  runMergeGateFn?: typeof runMergeGate;
  runWorkerPoolFn?: typeof runWorkerPool;
}

export interface GateWithReviseResult {
  /** The FINAL gate's decision (the one the caller exits on). */
  panelDecision: PanelDecision;
  mergedTaskIds: string[];
  /** The full final gate result. */
  gate: MergeGateResult;
  /** Every retry re-enqueued across all revise rounds. */
  attempts: ReviseAttemptRecord[];
  /** Number of revise rounds actually run (0 = only the initial gate). */
  reviseIterations: number;
  /** True when the budget was exhausted while the panel still wanted revise. */
  exhausted: boolean;
  totalPanelCost: number;
  totalPoolCost: number;
}

/** Severity ordering for finding prioritization (mirrors panel.ts). */
function severityRank(s: string): number {
  return (
    ({ critical: 3, high: 2, medium: 1, low: 0 } as Record<string, number>)[
      s
    ] ?? 0
  );
}

/**
 * Build transient corrective feedback from a gate's PanelDecision. Never reads
 * or mutates the contract — this is render-time context only.
 */
export function buildContractFeedback(
  decision: PanelDecision,
  attempt: number,
): PriorAttemptFeedback {
  // Failed acceptance criteria, deduped by criterion text.
  const seen = new Set<string>();
  const failedCriteria: { criterion: string; evidence?: string }[] = [];
  for (const v of decision.verdicts) {
    for (const c of v.criteriaResults ?? []) {
      if (c.pass) continue;
      if (seen.has(c.criterion)) continue;
      seen.add(c.criterion);
      failedCriteria.push({ criterion: c.criterion, evidence: c.evidence });
    }
  }

  // Top findings from non-errored verdicts, highest severity first.
  const findings = decision.verdicts
    .filter((v) => !v.error)
    .flatMap((v) => v.findings)
    .slice()
    .sort(
      (a: ReviewFinding, b: ReviewFinding) =>
        severityRank(b.severity) - severityRank(a.severity),
    )
    .slice(0, 10)
    .map((f) => ({
      severity: f.severity,
      description: f.description,
      file: f.file,
    }));

  return {
    attempt,
    failedCriteria,
    findings,
    dissent: decision.dissent,
    summary: decision.combinedRationale,
  };
}

/**
 * Choose the model for a retry. Rotation prefers a DIFFERENT provider family
 * from the failed attempt's author, filtering to available + tool-calling
 * models and picking the top by judge capability. Explicit degrade to
 * same-model-with-feedback when no different-family model is available; a
 * run-wide pin disables rotation entirely.
 */
export function chooseRetryModel(args: {
  failedModelId?: string;
  models: ModelEntry[];
  pinnedModelId?: string;
}): { preferredModelId?: string; rotation: string } {
  const { failedModelId, models, pinnedModelId } = args;

  if (pinnedModelId) {
    return { preferredModelId: pinnedModelId, rotation: "pinned-global-model" };
  }

  const failed = models.find((m) => m.id === failedModelId);
  const failedFamily = failed?.provider;

  const eligible = models.filter(
    (m) =>
      m.status === "available" &&
      m.capabilities.toolCalling &&
      (failedFamily === undefined || m.provider !== failedFamily),
  );

  // <1 different-family candidate → degrade to same model, still with feedback.
  if (eligible.length === 0) {
    return {
      ...(failedModelId ? { preferredModelId: failedModelId } : {}),
      rotation: "degraded-same-model",
    };
  }

  eligible.sort(
    (a, b) =>
      scoreJudgeCapability(b) - scoreJudgeCapability(a) ||
      a.id.localeCompare(b.id),
  );
  return {
    preferredModelId: eligible[0].id,
    rotation: `rotated:${eligible[0].id}`,
  };
}

/**
 * Run the bounded merge-gate revise loop.
 */
export async function runGateWithRevise(
  opts: GateWithReviseOptions,
): Promise<GateWithReviseResult> {
  const {
    runId,
    db,
    projectPath,
    panel,
    subagentOptions,
    registry,
    getModels,
    skipBuildVerify = false,
    autoMerge = true,
    concurrency = 3,
    maxReviseIterations,
    pinnedModelId,
    onPoolEvent,
    onGate,
    onRevise,
    runMergeGateFn = runMergeGate,
    runWorkerPoolFn = runWorkerPool,
  } = opts;

  const taskRepo = new OrchestrationTaskRepository(db);
  const contractRepo = new ContractRepository(db);

  // A run carries "real" contracts only when the planner emitted per-task
  // contracts (emitContracts=true). When loadRunContract synthesizes one, the
  // loop never fires — synthetic contracts have generic criteria and no
  // producerModelId, so a retry is not meaningful.
  const contractsAreReal = contractRepo.listByRun(runId).length > 0;

  const attempts: ReviseAttemptRecord[] = [];
  let totalPanelCost = 0;
  let totalPoolCost = 0;
  let reviseIterations = 0;
  let exhausted = false;

  // Per-task option overrides for the NEXT pool run (rotated model + feedback).
  // Empty on the initial pass → the original tasks run exactly as today.
  let pendingPerTask: Record<string, Partial<SubagentOptions>> = {};
  // Retry rows enqueued in the last revise round (for exhaustion annotation).
  let lastRoundNewTaskIds: string[] = [];
  const retriedContractIds = new Set<string>();

  let gate!: MergeGateResult;

  for (let attempt = 0; ; attempt++) {
    // ── Pool pass ──────────────────────────────────────────────────────
    // attempt 0: the planner's original pending tasks.
    // attempt N: the retry rows enqueued at the end of round N-1.
    const poolGen = runWorkerPoolFn({
      runId,
      db,
      subagentOptions,
      concurrency,
      preserveWorktrees: true,
      perTaskOptions: pendingPerTask,
    });
    while (true) {
      const next = await poolGen.next();
      if (next.done) {
        totalPoolCost += next.value.totalCost;
        break;
      }
      onPoolEvent?.(next.value, attempt);
    }
    pendingPerTask = {};

    // ── Gate ───────────────────────────────────────────────────────────
    gate = await runMergeGateFn({
      runId,
      db,
      projectPath,
      panel,
      subagentOptions,
      registry,
      getModels,
      skipBuildVerify,
      autoMerge,
    });
    totalPanelCost += gate.panelDecision.totalCost;
    onGate?.(gate, attempt);

    const decision = gate.panelDecision.decision;

    // approve / reject → done. approve already merged inside runMergeGate.
    if (decision !== "revise") break;
    // Budget exhausted.
    if (attempt >= maxReviseIterations) {
      exhausted = contractsAreReal && attempt > 0;
      break;
    }
    // Synthetic contract → no meaningful retry; today's print-and-exit.
    if (!contractsAreReal) break;

    // ── Task selection ─────────────────────────────────────────────────
    // MVP: retry every non-merged, completed task that carries a real
    // contract. Merged/approved tasks are structurally unreachable (approve
    // breaks the loop above), but exclude mergedTaskIds defensively.
    const merged = new Set(gate.mergedTaskIds);
    const selectable = taskRepo
      .listByRun(runId)
      .filter(
        (t) =>
          t.status === "completed" &&
          Boolean(t.contractId) &&
          !merged.has(t.id),
      );
    if (selectable.length === 0) break;

    // ── Re-enqueue one revise round ────────────────────────────────────
    const nextAttempt = attempt + 1;
    reviseIterations = nextAttempt;
    const feedback = buildContractFeedback(gate.panelDecision, nextAttempt);
    const roundRecords: ReviseAttemptRecord[] = [];
    const roundNewTaskIds: string[] = [];

    for (const t of selectable) {
      const contract = t.contractId
        ? contractRepo.getById(t.contractId)
        : undefined;
      const failedModelId = contract?.provenance.producerModelId;
      const { preferredModelId, rotation } = chooseRetryModel({
        failedModelId,
        models: getModels(),
        pinnedModelId,
      });

      // NEW row (never reset-in-place) so the failed attempt's worktree,
      // error, and verdicts survive as evidence. Deps are empty — the
      // original's deps already completed.
      const retry = taskRepo.create({
        runId,
        projectId: t.projectId,
        prompt: t.prompt,
        subagentType: t.subagentType,
        dependsOn: [],
      });
      // Carry the contract + lineage onto the fresh row (raw UPDATE mirrors the
      // producer_model_id write pattern in the worker pool).
      db.prepare(
        `UPDATE orchestration_tasks
         SET contract_id = ?, retry_of = ?, attempt = ?, rotation = ?
         WHERE id = ?`,
      ).run(t.contractId ?? null, t.id, nextAttempt, rotation, retry.id);

      // Supersede the original so it can never be re-claimed. Its row (worktree,
      // files_touched, error) is preserved as the lineage anchor.
      taskRepo.failTask(t.id, `superseded by revise attempt ${retry.id}`);

      // Re-arm the contract for the retry. The worker's own completion writes
      // fulfilled/failed again and overwrites producer_model_id to the retry's
      // author — exactly what the next gate's diversity exclusion needs.
      if (t.contractId) {
        retriedContractIds.add(t.contractId);
        contractRepo.updateStatus(t.contractId, "executing");
      }

      pendingPerTask[retry.id] = {
        ...(preferredModelId ? { preferredModelId } : {}),
        contractFeedback: feedback,
      };

      const record: ReviseAttemptRecord = {
        attempt: nextAttempt,
        originalTaskId: t.id,
        newTaskId: retry.id,
        contractId: t.contractId ?? "",
        failedModelId,
        preferredModelId,
        rotation,
      };
      roundRecords.push(record);
      roundNewTaskIds.push(retry.id);
      attempts.push(record);
    }

    lastRoundNewTaskIds = roundNewTaskIds;
    onRevise?.(roundRecords, nextAttempt);
    log.info(
      { runId, attempt: nextAttempt, retried: roundRecords.length },
      "Revise round enqueued",
    );
  }

  // ── Exhaustion ───────────────────────────────────────────────────────
  // Final round still wants revise: mark the retried contracts failed (the last
  // PanelDecision, already persisted, is the terminal evidence) and annotate the
  // final task rows. The tasks stay 'completed' (their diff exists in preserved
  // worktrees) but unmerged.
  if (exhausted) {
    for (const contractId of retriedContractIds) {
      contractRepo.updateStatus(contractId, "failed");
    }
    for (const id of lastRoundNewTaskIds) {
      db.prepare(`UPDATE orchestration_tasks SET error = ? WHERE id = ?`).run(
        "revise budget exhausted",
        id,
      );
    }
    log.warn(
      { runId, reviseIterations },
      "Revise budget exhausted — final decision still 'revise'",
    );
  }

  return {
    panelDecision: gate.panelDecision,
    mergedTaskIds: gate.mergedTaskIds,
    gate,
    attempts,
    reviseIterations,
    exhausted,
    totalPanelCost,
    totalPoolCost,
  };
}
