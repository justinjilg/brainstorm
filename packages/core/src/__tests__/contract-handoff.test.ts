import { describe, it, expect } from "vitest";
import {
  resolveToolScope,
  applyReadOnlyDowngrade,
  contractAuthorityOptions,
} from "../agent/subagent.js";
import { runMergeGate } from "../plan/judge-panel.js";
import type { JudgeDecision } from "../plan/multi-agent-judge.js";
import {
  createContract,
  validateContractOutput,
  DEFAULT_PANELS,
  type PanelSpawn,
} from "@brainst0rm/contracts";
import { getOutputSchema } from "@brainst0rm/agents";
import { getTestDb } from "@brainst0rm/db";
import type { AgentContract, ModelEntry } from "@brainst0rm/shared";

// READ_ONLY_TOOLS mirrors the set in spawnSubagent's downgrade path.
const READ_ONLY_TOOLS = [
  "file_read",
  "glob",
  "grep",
  "list_dir",
  "git_status",
  "git_diff",
  "git_log",
];

function contractWith(
  authority: AgentContract["authority"],
  schemaRef?: string,
): AgentContract {
  return createContract({
    intent: "do the thing",
    inputs: { task: "implement" },
    output: { contentType: schemaRef ? "json" : "text", schemaRef },
    acceptance: [],
    authority,
    provenance: {},
    status: "issued",
  });
}

// ── Worker handoff: authority maps through the narrowing chain ──────────

describe("contractAuthorityOptions — authority → narrowing chain", () => {
  it("maps authority.toolAllowlist + readOnly through resolveToolScope + downgrade", () => {
    const c = contractWith({
      toolAllowlist: ["file_read", "grep", "file_write"],
      readOnly: true,
    });
    const mapped = contractAuthorityOptions(c, {});
    expect(mapped.toolAllowlist).toEqual(["file_read", "grep", "file_write"]);
    expect(mapped.readOnly).toBe(true);

    // Feed the mapping through the SAME chain spawnSubagent uses.
    let scoped = resolveToolScope("all", mapped.toolAllowlist);
    if (mapped.readOnly) {
      scoped = applyReadOnlyDowngrade(scoped, READ_ONLY_TOOLS);
    }
    // file_write is a mutating tool → removed by the read-only downgrade;
    // file_read + grep survive.
    expect(scoped).toEqual(["file_read", "grep"]);
  });

  it("maps maxSteps and budget from authority, letting explicit options win", () => {
    const c = contractWith({ maxSteps: 5, budgetLimitUsd: 0.5 });
    // No explicit options → authority applies.
    expect(contractAuthorityOptions(c, {})).toMatchObject({
      maxSteps: 5,
      budgetLimit: 0.5,
    });
    // Explicit option overrides authority (floor semantics).
    expect(
      contractAuthorityOptions(c, { maxSteps: 3, budgetLimit: 0.1 }),
    ).toMatchObject({ maxSteps: 3, budgetLimit: 0.1 });
  });

  it("undefined authority fields leave the narrowing inputs untouched", () => {
    const c = contractWith({});
    expect(contractAuthorityOptions(c, {})).toEqual({
      toolAllowlist: undefined,
      maxSteps: undefined,
      budgetLimit: undefined,
      readOnly: undefined,
    });
  });
});

// ── Worker handoff: output validation (schema-valid vs schema-invalid) ──

describe("contract output validation (worker handoff)", () => {
  const c = contractWith({}, "code-changes");

  it("accepts a schema-valid worker response", () => {
    const validText =
      "Here you go:\n```json\n" +
      JSON.stringify({
        files: [{ path: "a.ts", content: "x", action: "create" }],
        summary: "did it",
        confidence: 0.9,
      }) +
      "\n```";
    const r = validateContractOutput(c, validText, getOutputSchema);
    expect(r.ok).toBe(true);
    expect((r.parsed as any).summary).toBe("did it");
  });

  it("rejects a schema-invalid worker response with errors", () => {
    const invalidText = "```json\n" + JSON.stringify({ nope: true }) + "\n```";
    const r = validateContractOutput(c, invalidText, getOutputSchema);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

// ── Merge gate: blocks autoMerge on a non-approve decision ──────────────

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
      qualityTier: 4,
      speedTier: 3,
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

const POOL = [
  model("anthropic/opus", "anthropic"),
  model("openai/gpt", "openai"),
  model("google/gemini", "google"),
];

function fakeJudge(decision: JudgeDecision["decision"]): JudgeDecision {
  return {
    decision,
    verdicts: [
      {
        taskId: "t1",
        worktreePath: "/tmp/wt1",
        verified: decision !== "revise",
        buildPassed: decision === "revise" ? false : true,
        testPassed: null,
        conflictingFiles: [],
        notes: "",
      },
    ],
    conflictMatrix: {},
    mergedTaskIds: [],
    durationMs: 1,
    reason: `deterministic ${decision}`,
  };
}

function judgeSpawn(perLensPass: (lens: string) => boolean): PanelSpawn {
  return async (req) => {
    // The lens is embedded in the promptAppend (buildLensPrompt); infer it.
    const lens = /SECURITY judge/i.test(req.promptAppend)
      ? "security"
      : /CORRECTNESS judge/i.test(req.promptAppend)
        ? "correctness"
        : "contract-fit";
    return {
      text: JSON.stringify({
        pass: perLensPass(lens),
        confidence: 0.9,
        rationale: `${lens} verdict`,
        findings: [],
      }),
      cost: 0.01,
      modelUsed: req.preferredModelId ?? "?",
      provider:
        POOL.find((m) => m.id === req.preferredModelId)?.provider ?? "?",
    };
  };
}

describe("runMergeGate — panel gate blocks autoMerge on non-approve", () => {
  it("merges when the panel approves", async () => {
    const db = getTestDb();
    const merges: string[][] = [];
    const gate = await runMergeGate({
      runId: "run_1",
      db,
      projectPath: "/tmp/proj",
      panel: DEFAULT_PANELS["merge-gate"],
      subagentOptions: {} as any,
      registry: {} as any,
      getModels: () => POOL,
      autoMerge: true,
      runJudgeFn: (async () => fakeJudge("approve")) as any,
      spawn: judgeSpawn(() => true), // every lens passes
      mergeFn: ((_p: string, v: any[]) => {
        merges.push(v.map((x) => x.taskId));
        return { mergedTaskIds: v.map((x) => x.taskId) };
      }) as any,
    });
    expect(gate.panelDecision.decision).toBe("approve");
    expect(gate.mergedTaskIds).toEqual(["t1"]);
    expect(merges.length).toBe(1);
    db.close();
  });

  it("does NOT merge when the security veto fails (reject)", async () => {
    const db = getTestDb();
    let merged = false;
    const gate = await runMergeGate({
      runId: "run_2",
      db,
      projectPath: "/tmp/proj",
      panel: DEFAULT_PANELS["merge-gate"],
      subagentOptions: {} as any,
      registry: {} as any,
      getModels: () => POOL,
      autoMerge: true,
      runJudgeFn: (async () => fakeJudge("approve")) as any,
      // security fails → veto → reject
      spawn: judgeSpawn((lens) => lens !== "security"),
      mergeFn: (() => {
        merged = true;
        return { mergedTaskIds: [] };
      }) as any,
    });
    expect(gate.panelDecision.decision).toBe("reject");
    expect(gate.mergedTaskIds).toEqual([]);
    expect(merged).toBe(false);
    db.close();
  });

  it("does NOT merge when autoMerge is false, even on approve", async () => {
    const db = getTestDb();
    let merged = false;
    const gate = await runMergeGate({
      runId: "run_3",
      db,
      projectPath: "/tmp/proj",
      panel: DEFAULT_PANELS["merge-gate"],
      subagentOptions: {} as any,
      registry: {} as any,
      getModels: () => POOL,
      autoMerge: false,
      runJudgeFn: (async () => fakeJudge("approve")) as any,
      spawn: judgeSpawn(() => true),
      mergeFn: (() => {
        merged = true;
        return { mergedTaskIds: [] };
      }) as any,
    });
    expect(gate.panelDecision.decision).toBe("approve");
    expect(merged).toBe(false);
    db.close();
  });

  it("blocks merge when deterministic build/test fails (build-test veto), even if all LLM judges pass", async () => {
    const db = getTestDb();
    let merged = false;
    const gate = await runMergeGate({
      runId: "run_5",
      db,
      projectPath: "/tmp/proj",
      panel: DEFAULT_PANELS["merge-gate"],
      subagentOptions: {} as any,
      registry: {} as any,
      getModels: () => POOL,
      autoMerge: true,
      // deterministic verification says revise (build failed)...
      runJudgeFn: (async () => fakeJudge("revise")) as any,
      // ...but all three lenient LLM judges pass.
      spawn: judgeSpawn(() => true),
      mergeFn: (() => {
        merged = true;
        return { mergedTaskIds: [] };
      }) as any,
    });
    // The deterministic panelist is a veto lens — it cannot be out-voted.
    expect(gate.panelDecision.decision).toBe("reject");
    expect(merged).toBe(false);
    db.close();
  });

  it("deterministic panel reproduces runJudge's REJECT (hard conflict), not a downgraded revise", async () => {
    // {judges:[], includeDeterministic:true} must degenerate to EXACTLY today's
    // runJudge behavior. A 'reject' from runJudge (file conflicts / no-op) must
    // stay 'reject' through the deterministic panel — not soften to 'revise'.
    const db = getTestDb();
    let merged = false;
    const gate = await runMergeGate({
      runId: "run_det_reject",
      db,
      projectPath: "/tmp/proj",
      panel: DEFAULT_PANELS["deterministic"],
      subagentOptions: {} as any,
      registry: {} as any,
      getModels: () => POOL,
      autoMerge: true,
      runJudgeFn: (async () => fakeJudge("reject")) as any,
      spawn: judgeSpawn(() => true),
      mergeFn: (() => {
        merged = true;
        return { mergedTaskIds: [] };
      }) as any,
    });
    expect(gate.panelDecision.decision).toBe("reject");
    expect(merged).toBe(false);
    db.close();
  });

  it("deterministic panel preserves runJudge's REVISE (retryable build/test fail)", async () => {
    const db = getTestDb();
    const gate = await runMergeGate({
      runId: "run_det_revise",
      db,
      projectPath: "/tmp/proj",
      panel: DEFAULT_PANELS["deterministic"],
      subagentOptions: {} as any,
      registry: {} as any,
      getModels: () => POOL,
      autoMerge: true,
      runJudgeFn: (async () => fakeJudge("revise")) as any,
      spawn: judgeSpawn(() => true),
      mergeFn: (() => ({ mergedTaskIds: [] })) as any,
    });
    expect(gate.panelDecision.decision).toBe("revise");
    db.close();
  });

  it("deterministic panel APPROVES + merges when runJudge approves", async () => {
    const db = getTestDb();
    const merges: string[][] = [];
    const gate = await runMergeGate({
      runId: "run_det_approve",
      db,
      projectPath: "/tmp/proj",
      panel: DEFAULT_PANELS["deterministic"],
      subagentOptions: {} as any,
      registry: {} as any,
      getModels: () => POOL,
      autoMerge: true,
      runJudgeFn: (async () => fakeJudge("approve")) as any,
      spawn: judgeSpawn(() => true),
      mergeFn: ((_p: string, v: any[]) => {
        merges.push(v.map((x) => x.taskId));
        return { mergedTaskIds: v.map((x) => x.taskId) };
      }) as any,
    });
    expect(gate.panelDecision.decision).toBe("approve");
    expect(gate.mergedTaskIds).toEqual(["t1"]);
    db.close();
  });

  it("persists verdicts + decision to the panel tables", async () => {
    const db = getTestDb();
    const gate = await runMergeGate({
      runId: "run_4",
      db,
      projectPath: "/tmp/proj",
      panel: DEFAULT_PANELS["merge-gate"],
      subagentOptions: {} as any,
      registry: {} as any,
      getModels: () => POOL,
      autoMerge: false,
      runJudgeFn: (async () => fakeJudge("approve")) as any,
      spawn: judgeSpawn(() => true),
      mergeFn: (() => ({ mergedTaskIds: [] })) as any,
    });
    const verdictRows = db
      .prepare("SELECT COUNT(*) AS n FROM panel_verdicts WHERE panel_id = ?")
      .get(gate.panelDecision.panelId) as { n: number };
    // 3 LLM judges + 1 deterministic panelist folded in.
    expect(verdictRows.n).toBe(4);
    const decisionRow = db
      .prepare("SELECT decision FROM panel_decisions WHERE id = ?")
      .get(gate.panelDecision.panelId) as { decision: string };
    expect(decisionRow.decision).toBe("approve");
    db.close();
  });
});
