import { describe, it, expect } from "vitest";
import { getTestDb } from "@brainst0rm/db";
import { ContractRepository, VerdictRepository } from "@brainst0rm/db";
import { OrchestrationTaskRepository } from "@brainst0rm/orchestrator";
import { createContract, renderContractPrompt } from "@brainst0rm/contracts";
import type {
  AgentContract,
  ModelEntry,
  PanelDecision,
  Verdict,
} from "@brainst0rm/shared";
import {
  runGateWithRevise,
  chooseRetryModel,
  buildContractFeedback,
} from "../plan/revise-loop.js";
import type { MergeGateResult } from "../plan/judge-panel.js";
import type {
  WorkerPoolEvent,
  WorkerPoolResult,
} from "../plan/multi-agent-worker-pool.js";

// ── Model pool (three provider families) ────────────────────────────────
function model(id: string, provider: string): ModelEntry {
  return {
    id,
    provider,
    name: id,
    capabilities: {
      toolCalling: true,
      streaming: true,
      vision: false,
      reasoning: true,
      contextWindow: 200000,
      qualityTier: "high",
      speedTier: "medium",
      bestFor: [],
      capabilityScores: {
        toolSelection: 0.8,
        toolSequencing: 0.8,
        codeGeneration: 0.8,
        multiStepReasoning: 0.8,
        instructionFollowing: 0.8,
        contextUtilization: 0.8,
        selfCorrection: 0.8,
      },
    },
    pricing: { inputPer1MTokens: 1, outputPer1MTokens: 3 },
    limits: { contextWindow: 200000, maxOutputTokens: 8192 },
    status: "available",
    isLocal: false,
    lastHealthCheck: 0,
  } as ModelEntry;
}

const POOL: ModelEntry[] = [
  model("anthropic/opus-4.6", "anthropic"),
  model("openai/gpt-5.4", "openai"),
  model("google/gemini-3.1-pro", "google"),
];

// ── Test-DB seeding ─────────────────────────────────────────────────────
function seedRun(db: any, runId: string): { projectId: string } {
  const projectId = "proj_1";
  db.prepare(
    "INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, unixepoch(), unixepoch())",
  ).run(projectId, "Proj", "/tmp/proj");
  db.prepare(
    "INSERT INTO orchestration_runs (id, name, description, project_ids, created_at, updated_at) VALUES (?, ?, ?, ?, unixepoch(), unixepoch())",
  ).run(runId, "run", "desc", JSON.stringify([projectId]));
  return { projectId };
}

/** Seed one pending task with a REAL per-task contract, mirroring the
 * emitContracts=true planner path. Returns the task id + contract. */
function seedTaskWithContract(
  db: any,
  runId: string,
  projectId: string,
): { taskId: string; contract: AgentContract } {
  const taskRepo = new OrchestrationTaskRepository(db);
  const task = taskRepo.create({
    runId,
    projectId,
    prompt: "implement the widget",
    subagentType: "code",
  });
  const contract = createContract({
    intent: "build the widget",
    inputs: { task: "implement the widget" },
    output: { contentType: "text" },
    acceptance: [{ kind: "criterion", text: "tests pass" }],
    authority: {},
    provenance: { runId, taskId: task.id },
    status: "issued",
  });
  new ContractRepository(db).save(contract);
  db.prepare("UPDATE orchestration_tasks SET contract_id = ? WHERE id = ?").run(
    contract.id,
    task.id,
  );
  return { taskId: task.id, contract };
}

// ── Stubs ───────────────────────────────────────────────────────────────
interface SpawnCall {
  taskId: string;
  preferredModelId?: string;
  contractFeedback?: any;
}

/** A worker-pool stub that emulates the real pool: completes each pending task
 * and stamps producer_model_id on its contract (as worker-pool.ts does). */
function makeWorkerPoolStub(spawnCalls: SpawnCall[], initialModel: string) {
  return async function* (
    options: any,
  ): AsyncGenerator<WorkerPoolEvent, WorkerPoolResult> {
    const taskRepo = new OrchestrationTaskRepository(options.db);
    const pending = taskRepo
      .listByRun(options.runId)
      .filter((t) => t.status === "pending");
    for (const t of pending) {
      const override = options.perTaskOptions?.[t.id] ?? {};
      const modelUsed: string = override.preferredModelId ?? initialModel;
      spawnCalls.push({
        taskId: t.id,
        preferredModelId: override.preferredModelId,
        contractFeedback: override.contractFeedback,
      });
      taskRepo.completeWithMetadata(t.id, {
        resultSummary: "done",
        cost: 0.1,
        worktreePath: `/tmp/wt-${t.id.slice(0, 8)}`,
        filesTouched: ["a.ts"],
      });
      if (t.contractId) {
        options.db
          .prepare(
            "UPDATE agent_contracts SET producer_model_id = ?, updated_at = ? WHERE id = ?",
          )
          .run(modelUsed, Math.floor(Date.now() / 1000), t.contractId);
      }
    }
    yield {
      type: "pool-finished",
      totalCompleted: pending.length,
      totalFailed: 0,
    };
    return {
      runId: options.runId,
      status: "completed",
      totalCompleted: pending.length,
      totalFailed: 0,
      totalCost: pending.length * 0.1,
      durationMs: 1,
      worktrees: [],
    };
  };
}

/** A gate stub that returns a scripted decision sequence, persists each
 * PanelDecision (like the real gate), and records a merge on approve. */
function makeGateStub(
  decisions: Array<"approve" | "revise" | "reject">,
  mergeCalls: string[],
) {
  let i = 0;
  return async (options: any): Promise<MergeGateResult> => {
    const decision = decisions[Math.min(i, decisions.length - 1)];
    i++;
    const panelId = `panel_${i}`;
    const verdict: Verdict = {
      judgeId: "contract-fit:gpt-5.4",
      lens: "contract-fit",
      modelId: "gpt-5.4",
      provider: "openai",
      pass: decision === "approve",
      confidence: 0.9,
      rationale: `${decision} rationale`,
      findings:
        decision === "approve"
          ? []
          : [
              {
                severity: "high",
                description: "tests broken",
                file: "a.ts",
                reviewer: "contract-fit:gpt-5.4",
              },
            ],
      criteriaResults: [
        {
          criterion: "tests pass",
          pass: decision === "approve",
          evidence: decision === "approve" ? undefined : "2 failing",
        },
      ],
      cost: 0.01,
      durationMs: 1,
    };
    const panelDecision: PanelDecision = {
      panelId,
      decision,
      verdicts: [verdict],
      quorum: {
        required: 2,
        achieved: decision === "approve" ? 2 : 1,
        rule: "majority",
      },
      dissent:
        decision === "approve"
          ? []
          : ["contract-fit:gpt-5.4: criterion 2 unmet"],
      combinedRationale: `combined ${decision}`,
      totalCost: 0.03,
    };

    const verdictRepo = new VerdictRepository(options.db);
    for (const v of panelDecision.verdicts) {
      verdictRepo.recordVerdict(v, { panelId, runId: options.runId });
    }
    verdictRepo.recordDecision(panelDecision, { runId: options.runId });

    // Emulate the real gate: merge the completed tasks on approve + autoMerge.
    let mergedTaskIds: string[] = [];
    if (decision === "approve" && options.autoMerge) {
      const taskRepo = new OrchestrationTaskRepository(options.db);
      mergedTaskIds = taskRepo
        .listByRun(options.runId)
        .filter((t) => t.status === "completed")
        .map((t) => t.id);
      mergeCalls.push(options.runId);
    }

    return {
      judgeDecision: {
        decision: decision === "approve" ? "approve" : "revise",
        verdicts: [],
        conflictMatrix: {},
        mergedTaskIds: [],
        durationMs: 1,
        reason: "stub",
      } as any,
      panelDecision,
      mergedTaskIds,
    };
  };
}

function baseOpts(db: any, runId: string) {
  return {
    runId,
    db,
    projectPath: "/tmp/proj",
    panel: {} as any,
    subagentOptions: {} as any,
    registry: {} as any,
    getModels: () => POOL,
    autoMerge: true,
  };
}

// ── Pure helpers ────────────────────────────────────────────────────────
describe("chooseRetryModel", () => {
  it("rotates to a different provider family", () => {
    const r = chooseRetryModel({
      failedModelId: "anthropic/opus-4.6",
      models: POOL,
    });
    expect(r.preferredModelId).toBeDefined();
    const chosen = POOL.find((m) => m.id === r.preferredModelId)!;
    expect(chosen.provider).not.toBe("anthropic");
    expect(r.rotation).toBe(`rotated:${r.preferredModelId}`);
  });

  it("rotates when producerModelId is a display NAME, not the catalog id (production divergence)", () => {
    // In production the worker pool stamps producer_model_id with
    // decision.model.name (e.g. "Claude Opus 4.6"), which is NOT the catalog
    // id ("anthropic/claude-opus-4-6"). chooseRetryModel must still resolve the
    // failed family from the name so it rotates to a different provider.
    const pool = [
      {
        ...model("anthropic/claude-opus-4-6", "anthropic"),
        name: "Claude Opus 4.6",
      },
      { ...model("openai/gpt-5.4", "openai"), name: "GPT-5.4" },
    ] as ModelEntry[];
    const r = chooseRetryModel({
      failedModelId: "Claude Opus 4.6", // the NAME, as stored in production
      models: pool,
    });
    expect(r.preferredModelId).toBe("openai/gpt-5.4");
    expect(r.rotation).toBe("rotated:openai/gpt-5.4");
  });

  it("degrades (not mislabels) when producerModelId is a NAME and only one family exists", () => {
    // Same name/id divergence, single-provider install: must degrade to the
    // same model, NOT return a same-family model tagged 'rotated:'.
    const pool = [
      {
        ...model("anthropic/claude-opus-4-6", "anthropic"),
        name: "Claude Opus 4.6",
      },
      {
        ...model("anthropic/claude-sonnet-4-6", "anthropic"),
        name: "Claude Sonnet 4.6",
      },
    ] as ModelEntry[];
    const r = chooseRetryModel({
      failedModelId: "Claude Opus 4.6",
      models: pool,
    });
    expect(r.rotation).toBe("degraded-same-model");
    expect(r.preferredModelId).toBe("Claude Opus 4.6");
  });

  it("degrades to same-model when only one provider family exists", () => {
    const single = [model("anthropic/opus-4.6", "anthropic")];
    const r = chooseRetryModel({
      failedModelId: "anthropic/opus-4.6",
      models: single,
    });
    expect(r.rotation).toBe("degraded-same-model");
    expect(r.preferredModelId).toBe("anthropic/opus-4.6");
  });

  it("a run-wide pin disables rotation", () => {
    const r = chooseRetryModel({
      failedModelId: "anthropic/opus-4.6",
      models: POOL,
      pinnedModelId: "anthropic/opus-4.6",
    });
    expect(r.rotation).toBe("pinned-global-model");
    expect(r.preferredModelId).toBe("anthropic/opus-4.6");
  });

  it("skips unavailable / non-tool-calling models", () => {
    const pool = [
      model("anthropic/opus-4.6", "anthropic"),
      {
        ...model("openai/gpt-5.4", "openai"),
        status: "unavailable",
      } as ModelEntry,
      {
        ...model("google/gemini-3.1-pro", "google"),
        capabilities: {
          ...model("google/gemini-3.1-pro", "google").capabilities,
          toolCalling: false,
        },
      } as ModelEntry,
    ];
    const r = chooseRetryModel({
      failedModelId: "anthropic/opus-4.6",
      models: pool,
    });
    // Both alternatives are ineligible → degrade.
    expect(r.rotation).toBe("degraded-same-model");
  });
});

describe("buildContractFeedback", () => {
  it("extracts failed criteria, dissent, findings, and summary", () => {
    const decision: PanelDecision = {
      panelId: "p",
      decision: "revise",
      verdicts: [
        {
          judgeId: "j",
          lens: "contract-fit",
          modelId: "m",
          provider: "openai",
          pass: false,
          confidence: 0.5,
          rationale: "r",
          findings: [
            { severity: "low", description: "nit", reviewer: "j" },
            {
              severity: "critical",
              description: "boom",
              file: "x.ts",
              reviewer: "j",
            },
          ],
          criteriaResults: [
            { criterion: "tests pass", pass: false, evidence: "2 failing" },
            { criterion: "no security defect", pass: true },
          ],
          cost: 0,
          durationMs: 0,
        },
      ],
      quorum: { required: 1, achieved: 0, rule: "majority" },
      dissent: ["j: unmet"],
      combinedRationale: "please fix",
      totalCost: 0,
    };
    const fb = buildContractFeedback(decision, 1);
    expect(fb.attempt).toBe(1);
    expect(fb.failedCriteria).toEqual([
      { criterion: "tests pass", evidence: "2 failing" },
    ]);
    expect(fb.findings[0].severity).toBe("critical"); // highest first
    expect(fb.dissent).toEqual(["j: unmet"]);
    expect(fb.summary).toBe("please fix");
  });
});

// ── Loop behavior ───────────────────────────────────────────────────────
describe("runGateWithRevise", () => {
  it("revise → approve: re-enqueues one attempt with feedback + rotated model, merges once", async () => {
    const db = getTestDb();
    const runId = "run_revise_approve";
    const { projectId } = seedRun(db, runId);
    const { taskId, contract } = seedTaskWithContract(db, runId, projectId);

    const spawnCalls: SpawnCall[] = [];
    const mergeCalls: string[] = [];

    const result = await runGateWithRevise({
      ...baseOpts(db, runId),
      maxReviseIterations: 1,
      runWorkerPoolFn: makeWorkerPoolStub(
        spawnCalls,
        "anthropic/opus-4.6",
      ) as any,
      runMergeGateFn: makeGateStub(["revise", "approve"], mergeCalls) as any,
    });

    // (a) exactly one new row with retry_of=original, attempt=1; original
    // superseded.
    const taskRepo = new OrchestrationTaskRepository(db);
    const rows = taskRepo.listByRun(runId);
    const retryRow = rows.find((r) => r.retryOf === taskId);
    expect(retryRow).toBeDefined();
    expect(retryRow!.attempt).toBe(1);
    expect(retryRow!.contractId).toBe(contract.id);
    const original = rows.find((r) => r.id === taskId)!;
    expect(original.status).toBe("failed");
    expect(original.error).toContain("superseded");
    expect(rows.filter((r) => r.retryOf).length).toBe(1);

    // (b) the retry spawn got a DIFFERENT-family preferredModelId + feedback,
    // and the rendered prompt carries the corrective section.
    const retrySpawn = spawnCalls.find((c) => c.taskId === retryRow!.id)!;
    expect(retrySpawn.preferredModelId).toBeDefined();
    expect(
      POOL.find((m) => m.id === retrySpawn.preferredModelId)!.provider,
    ).not.toBe("anthropic");
    expect(retrySpawn.contractFeedback).toBeDefined();
    const rendered = renderContractPrompt(contract, {
      priorAttempt: retrySpawn.contractFeedback,
    });
    expect(rendered).toContain("## Prior attempt — corrective feedback");
    expect(rendered).toContain("tests pass");
    expect(rendered).toContain("contract-fit:gpt-5.4: criterion 2 unmet");

    // (c) two PanelDecision records (revise then approve); merge exactly once.
    const decisionCount = (
      db
        .prepare("SELECT COUNT(*) AS n FROM panel_decisions WHERE run_id = ?")
        .get(runId) as { n: number }
    ).n;
    expect(decisionCount).toBe(2);
    expect(mergeCalls.length).toBe(1);
    expect(result.panelDecision.decision).toBe("approve");
    expect(result.reviseIterations).toBe(1);
    expect(result.exhausted).toBe(false);
    db.close();
  });

  it("maxIterations=0 is a pure no-op (no retry, one gate, no merge on revise)", async () => {
    const db = getTestDb();
    const runId = "run_noop";
    const { projectId } = seedRun(db, runId);
    const { taskId } = seedTaskWithContract(db, runId, projectId);

    const spawnCalls: SpawnCall[] = [];
    const mergeCalls: string[] = [];
    const result = await runGateWithRevise({
      ...baseOpts(db, runId),
      maxReviseIterations: 0,
      runWorkerPoolFn: makeWorkerPoolStub(
        spawnCalls,
        "anthropic/opus-4.6",
      ) as any,
      runMergeGateFn: makeGateStub(["revise"], mergeCalls) as any,
    });

    const rows = new OrchestrationTaskRepository(db).listByRun(runId);
    expect(rows.filter((r) => r.retryOf).length).toBe(0);
    expect(rows.find((r) => r.id === taskId)!.status).toBe("completed");
    const decisionCount = (
      db
        .prepare("SELECT COUNT(*) AS n FROM panel_decisions WHERE run_id = ?")
        .get(runId) as { n: number }
    ).n;
    expect(decisionCount).toBe(1); // one gate only
    expect(mergeCalls.length).toBe(0);
    expect(result.panelDecision.decision).toBe("revise");
    expect(result.exhausted).toBe(false);
    db.close();
  });

  it("approve on the first gate never retries", async () => {
    const db = getTestDb();
    const runId = "run_approve";
    const { projectId } = seedRun(db, runId);
    seedTaskWithContract(db, runId, projectId);
    const mergeCalls: string[] = [];
    const result = await runGateWithRevise({
      ...baseOpts(db, runId),
      maxReviseIterations: 3,
      runWorkerPoolFn: makeWorkerPoolStub([], "anthropic/opus-4.6") as any,
      runMergeGateFn: makeGateStub(["approve"], mergeCalls) as any,
    });
    const rows = new OrchestrationTaskRepository(db).listByRun(runId);
    expect(rows.filter((r) => r.retryOf).length).toBe(0);
    expect(mergeCalls.length).toBe(1);
    expect(result.reviseIterations).toBe(0);
    db.close();
  });

  it("reject on the first gate never retries", async () => {
    const db = getTestDb();
    const runId = "run_reject";
    const { projectId } = seedRun(db, runId);
    seedTaskWithContract(db, runId, projectId);
    const mergeCalls: string[] = [];
    const result = await runGateWithRevise({
      ...baseOpts(db, runId),
      maxReviseIterations: 3,
      runWorkerPoolFn: makeWorkerPoolStub([], "anthropic/opus-4.6") as any,
      runMergeGateFn: makeGateStub(["reject"], mergeCalls) as any,
    });
    const rows = new OrchestrationTaskRepository(db).listByRun(runId);
    expect(rows.filter((r) => r.retryOf).length).toBe(0);
    expect(mergeCalls.length).toBe(0);
    expect(result.reviseIterations).toBe(0);
    db.close();
  });

  it("revise both times with maxIterations=1: terminates after 2 gates, marks contract failed, no third pool run", async () => {
    const db = getTestDb();
    const runId = "run_exhaust";
    const { projectId } = seedRun(db, runId);
    const { contract } = seedTaskWithContract(db, runId, projectId);

    const spawnCalls: SpawnCall[] = [];
    const mergeCalls: string[] = [];
    let poolRuns = 0;
    const poolStub = makeWorkerPoolStub(spawnCalls, "anthropic/opus-4.6");
    const countingPool = async function* (options: any) {
      poolRuns++;
      return yield* poolStub(options);
    };

    const result = await runGateWithRevise({
      ...baseOpts(db, runId),
      maxReviseIterations: 1,
      runWorkerPoolFn: countingPool as any,
      runMergeGateFn: makeGateStub(["revise", "revise"], mergeCalls) as any,
    });

    expect(poolRuns).toBe(2); // initial + one retry round, no third
    const decisionCount = (
      db
        .prepare("SELECT COUNT(*) AS n FROM panel_decisions WHERE run_id = ?")
        .get(runId) as { n: number }
    ).n;
    expect(decisionCount).toBe(2);
    expect(mergeCalls.length).toBe(0);
    expect(result.exhausted).toBe(true);

    const c = new ContractRepository(db).getById(contract.id)!;
    expect(c.status).toBe("failed");

    // The final retry row is annotated as budget-exhausted.
    const rows = new OrchestrationTaskRepository(db).listByRun(runId);
    const finalRetry = rows.find((r) => r.attempt === 1)!;
    expect(finalRetry.error).toBe("revise budget exhausted");
    db.close();
  });

  it("a retry that FAILS in the worker pool marks its contract failed (no stuck 'executing')", async () => {
    const db = getTestDb();
    const runId = "run_retry_fail";
    const { projectId } = seedRun(db, runId);
    const { contract } = seedTaskWithContract(db, runId, projectId);

    const mergeCalls: string[] = [];
    // Pool: complete on the initial pass; FAIL any retry (a task carrying
    // per-task contractFeedback) via failTask WITHOUT touching contract status,
    // exactly like the real pool's throw / budget / no-file-change paths.
    const poolStub = async function* (
      options: any,
    ): AsyncGenerator<WorkerPoolEvent, WorkerPoolResult> {
      const taskRepo = new OrchestrationTaskRepository(options.db);
      const pending = taskRepo
        .listByRun(options.runId)
        .filter((t: any) => t.status === "pending");
      let failed = 0;
      let completed = 0;
      for (const t of pending) {
        const override = options.perTaskOptions?.[t.id] ?? {};
        if (override.contractFeedback) {
          taskRepo.failTask(t.id, "budget exceeded mid-task"); // no contract update
          failed++;
        } else {
          taskRepo.completeWithMetadata(t.id, {
            resultSummary: "done",
            cost: 0.1,
            worktreePath: `/tmp/wt-${t.id.slice(0, 8)}`,
            filesTouched: ["a.ts"],
          });
          if (t.contractId) {
            options.db
              .prepare(
                "UPDATE agent_contracts SET producer_model_id = ?, updated_at = ? WHERE id = ?",
              )
              .run(
                "anthropic/opus-4.6",
                Math.floor(Date.now() / 1000),
                t.contractId,
              );
          }
          completed++;
        }
      }
      yield {
        type: "pool-finished",
        totalCompleted: completed,
        totalFailed: failed,
      };
      return {
        runId: options.runId,
        status: failed > 0 ? "failed" : "completed",
        totalCompleted: completed,
        totalFailed: failed,
        totalCost: 0.1,
        durationMs: 1,
        worktrees: [],
      };
    };

    const result = await runGateWithRevise({
      ...baseOpts(db, runId),
      maxReviseIterations: 2,
      runWorkerPoolFn: poolStub as any,
      // revise on the first gate (enqueue retry), revise again (retry failed,
      // nothing selectable → break).
      runMergeGateFn: makeGateStub(["revise", "revise"], mergeCalls) as any,
    });

    // The contract must NOT be left stuck at 'executing' — the failed retry
    // resolved it to 'failed'.
    const c = new ContractRepository(db).getById(contract.id)!;
    expect(c.status).toBe("failed");
    expect(mergeCalls.length).toBe(0);
    // One retry row exists and it failed in the pool.
    const rows = new OrchestrationTaskRepository(db).listByRun(runId);
    const retry = rows.find((r) => r.attempt === 1)!;
    expect(retry.status).toBe("failed");
    db.close();
  });

  it("synthetic-contract run (no real contracts) never enters the loop", async () => {
    const db = getTestDb();
    const runId = "run_synth";
    const { projectId } = seedRun(db, runId);
    // Task WITHOUT a contract → contractsAreReal is false.
    new OrchestrationTaskRepository(db).create({
      runId,
      projectId,
      prompt: "do a thing",
      subagentType: "code",
    });
    const mergeCalls: string[] = [];
    const result = await runGateWithRevise({
      ...baseOpts(db, runId),
      maxReviseIterations: 2,
      runWorkerPoolFn: makeWorkerPoolStub([], "anthropic/opus-4.6") as any,
      runMergeGateFn: makeGateStub(["revise"], mergeCalls) as any,
    });
    const rows = new OrchestrationTaskRepository(db).listByRun(runId);
    expect(rows.filter((r) => r.retryOf).length).toBe(0);
    expect(result.reviseIterations).toBe(0);
    expect(result.exhausted).toBe(false);
    db.close();
  });
});
