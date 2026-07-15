/**
 * Merge-gate adapter — wires the pure JudgePanel primitive (@brainst0rm/contracts)
 * to the REAL orchestrator path: the injected spawnSubagent(type:'review'),
 * BrainstormRouter.getModels(), and runJudge's deterministic build/test verdict.
 *
 * The gate fires AFTER all workers complete and BEFORE autoMerge. It generalizes
 * today's single deterministic judge: the build/test verdict folds in as a
 * weight-2 panelist and N provider-diverse LLM judges review the run's diff
 * against a contract. autoMerge only proceeds when the PANEL decision is
 * 'approve'. Verdicts + the decision are persisted through VerdictRepository and
 * each judge's model cost is recorded through the CostTracker inside spawnSubagent.
 *
 * Opt-in: this path runs only when the CLI/TOML selects a panel. With no panel,
 * the caller uses runJudge directly — byte-for-byte today's behavior.
 */

import { OrchestrationTaskRepository } from "@brainst0rm/orchestrator";
import { ContractRepository, VerdictRepository } from "@brainst0rm/db";
import { getOutputSchema } from "@brainst0rm/agents";
import {
  runJudgePanel,
  createContract,
  type PanelSpawn,
  type PanelDeps,
} from "@brainst0rm/contracts";
import type {
  AgentContract,
  ModelEntry,
  PanelConfig,
  PanelDecision,
  Verdict,
} from "@brainst0rm/shared";
import { createLogger } from "@brainst0rm/shared";
import type { ProviderRegistry } from "@brainst0rm/providers";
import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { spawnSubagent, type SubagentOptions } from "../agent/subagent.js";
import {
  runJudge,
  mergeVerifiedWorktrees,
  type JudgeDecision,
} from "./multi-agent-judge.js";

const log = createLogger("judge-panel");

/**
 * Build a PanelSpawn that dispatches each judge through the real spawnSubagent
 * as a read-only 'review' subagent pinned to the selected model. The judge's
 * lens prompt is appended; maxSteps is capped by the panel (5). The model's
 * provider family is resolved from the registry for the decorrelation audit.
 */
export function createPanelSpawn(
  base: SubagentOptions,
  registry: ProviderRegistry,
): PanelSpawn {
  return async (req) => {
    const result = await spawnSubagent(req.task, {
      ...base,
      type: "review",
      preferredModelId: req.preferredModelId,
      promptAppend: req.promptAppend,
      maxSteps: req.maxSteps,
      ...(req.budgetLimit !== undefined
        ? { budgetLimit: req.budgetLimit }
        : {}),
    });
    const provider = req.preferredModelId
      ? (registry.getModel(req.preferredModelId)?.provider ?? "unknown")
      : "unknown";
    return {
      text: result.text,
      cost: result.cost,
      modelUsed: result.modelUsed,
      provider,
    };
  };
}

/** Synthesize a deterministic build/test Verdict from runJudge's decision, to
 * fold into the panel as the weight-2 panelist that "can't be sweet-talked".
 *
 * The failure finding's severity carries the runJudge distinction between a
 * hard, unmergeable failure (decision 'reject' — file conflicts / no-op / no
 * tasks: manual reconciliation required) and a retryable one (decision 'revise'
 * — build/test or execution failure). This matters for the `deterministic`
 * DEFAULT_PANEL (plain `majority` quorum, no build-test veto): decidePanelOutcome
 * only rejects a quorum-fail when a `critical` finding is present, so mapping a
 * 'reject' to `critical` (vs 'revise' → `high`) is what makes
 * `{judges:[], includeDeterministic:true}` degenerate to EXACTLY today's
 * three-way runJudge behavior (approve / revise / reject) rather than collapsing
 * a hard conflict into a retryable 'revise'. */
export function deterministicVerdict(judge: JudgeDecision): Verdict {
  const pass = judge.decision === "approve";
  return {
    judgeId: "build-test:deterministic",
    lens: "build-test",
    modelId: "deterministic",
    provider: "deterministic",
    pass,
    score: pass ? 1 : 0,
    confidence: 1,
    rationale: judge.reason,
    findings: pass
      ? []
      : [
          {
            // 'reject' is a hard, unmergeable failure → critical (drives the
            // majority-quorum deterministic panel to reject); 'revise' is
            // retryable → high.
            severity: judge.decision === "reject" ? "critical" : "high",
            description: judge.reason,
            reviewer: "build-test:deterministic",
          },
        ],
    cost: 0,
    durationMs: judge.durationMs,
  };
}

/** Combined git diff across the completed tasks' worktrees — the artifact the
 * LLM judges review. Best-effort: a worktree that can't be diffed is skipped. */
function gatherRunDiff(judge: JudgeDecision): string {
  const chunks: string[] = [];
  for (const v of judge.verdicts) {
    if (!v.worktreePath) continue;
    try {
      const diff = execFileSync("git", ["-C", v.worktreePath, "diff", "HEAD"], {
        encoding: "utf-8",
        timeout: 10000,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (diff.trim()) {
        chunks.push(`### Task ${v.taskId} (${v.worktreePath})\n${diff}`);
      }
    } catch {
      // best effort
    }
  }
  return chunks.join("\n\n").slice(0, 200_000) || "(no diff captured)";
}

export interface MergeGateOptions {
  runId: string;
  db: Database.Database;
  projectPath: string;
  /** The panel to run (e.g. DEFAULT_PANELS["merge-gate"]). */
  panel: PanelConfig;
  /** Base subagent options for judge spawns (registry/router/costTracker/...). */
  subagentOptions: SubagentOptions;
  /** Provider registry — resolves each judge model's provider family. */
  registry: ProviderRegistry;
  /** Model pool for diverse selection (BrainstormRouter.getModels). */
  getModels: () => ModelEntry[];
  /** Skip per-worktree build verification in the deterministic pass. */
  skipBuildVerify?: boolean;
  /** Perform the merges when the panel approves. Default true. */
  autoMerge?: boolean;
  // ── Test seams (injected in unit tests; defaulted to the real fns) ──
  runJudgeFn?: typeof runJudge;
  spawn?: PanelSpawn;
  mergeFn?: typeof mergeVerifiedWorktrees;
}

export interface MergeGateResult {
  judgeDecision: JudgeDecision;
  panelDecision: PanelDecision;
  mergedTaskIds: string[];
}

/**
 * Run the panel merge gate. Deterministic verification runs first (no merge);
 * its verdict folds into the panel; N diverse LLM judges review the run diff
 * against a contract; the panel decides; autoMerge proceeds ONLY on approve.
 */
export async function runMergeGate(
  opts: MergeGateOptions,
): Promise<MergeGateResult> {
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
    runJudgeFn = runJudge,
    mergeFn = mergeVerifiedWorktrees,
  } = opts;

  // 1) Deterministic pass — verdicts only, NO merge yet.
  const judgeDecision = await runJudgeFn({
    runId,
    db,
    projectPath,
    skipBuildVerify,
    autoMerge: false,
  });

  // 2) The contract the judges evaluate against: the run's first task contract
  // if the planner emitted one, else a minimal synthesized merge contract.
  const contract = loadRunContract(db, runId);
  const artifact = gatherRunDiff(judgeDecision);

  // 3) Run the panel (folding the deterministic verdict in as weight-2).
  const spawn = opts.spawn ?? createPanelSpawn(subagentOptions, registry);
  const deps: PanelDeps = {
    spawn,
    getModels,
    getOutputSchema,
    deterministicVerdict: deterministicVerdict(judgeDecision),
  };
  const panelDecision = await runJudgePanel(contract, artifact, panel, deps);

  // 4) Persist verdicts + decision (append-only evidence).
  const verdictRepo = new VerdictRepository(db);
  for (const v of panelDecision.verdicts) {
    verdictRepo.recordVerdict(v, {
      panelId: panelDecision.panelId,
      contractId: contract.id,
      runId,
    });
  }
  verdictRepo.recordDecision(panelDecision, { contractId: contract.id, runId });

  // 5) Merge ONLY on panel approve. The deterministic verdict (weight 2 +
  // security veto) means an approve here implies verification did not hard-fail.
  let mergedTaskIds: string[] = [];
  if (panelDecision.decision === "approve" && autoMerge) {
    const merge = mergeFn(projectPath, judgeDecision.verdicts);
    mergedTaskIds = merge.mergedTaskIds;
    if (merge.failure) {
      log.warn(
        { runId, failure: merge.failure },
        "Panel-approved merge failed",
      );
    }
  }

  log.info(
    {
      runId,
      panelDecision: panelDecision.decision,
      merged: mergedTaskIds.length,
      panelCost: panelDecision.totalCost,
    },
    "Merge gate finished",
  );

  return { judgeDecision, panelDecision, mergedTaskIds };
}

/** Load the run's contract, or synthesize a minimal merge contract when the
 * planner did not emit contracts (so the gate still runs against SOMETHING). */
function loadRunContract(db: Database.Database, runId: string): AgentContract {
  const contractRepo = new ContractRepository(db);
  const taskRepo = new OrchestrationTaskRepository(db);
  const existing = contractRepo.listByRun(runId);
  if (existing.length > 0) return existing[0];

  const tasks = taskRepo.listByRun(runId);
  const summary = tasks
    .map((t) => `- ${t.prompt.slice(0, 120)}`)
    .join("\n")
    .slice(0, 2000);
  return createContract({
    intent:
      "Verify the aggregate changes produced by this orchestration run are safe to merge to the project branch.",
    context: `Run ${runId} produced ${tasks.length} task(s):\n${summary}`,
    inputs: { task: "Review the combined diff for correctness and safety." },
    output: { contentType: "text" },
    acceptance: [
      {
        kind: "criterion",
        text: "The change is correct and does not regress existing behavior.",
      },
      { kind: "criterion", text: "The change introduces no security defect." },
    ],
    authority: {},
    provenance: { runId },
    status: "issued",
  });
}
