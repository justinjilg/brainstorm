import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  selectDiverseJudges,
  decidePanelOutcome,
  runJudgePanel,
  buildLensPrompt,
  runAcceptanceGatesAsync,
  createContract,
  DEFAULT_PANELS,
  type PanelSpawn,
  type PanelDeps,
} from "../index.js";
import type {
  ModelEntry,
  Verdict,
  QuorumSpec,
  AgentContract,
} from "@brainst0rm/shared";

// ── Fixtures ──────────────────────────────────────────────────────────

function model(id: string, provider: string, cap = 0.8): ModelEntry {
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
        toolSelection: cap,
        toolSequencing: cap,
        codeGeneration: cap,
        multiStepReasoning: cap,
        instructionFollowing: cap,
        contextUtilization: cap,
        selfCorrection: cap,
      },
    },
    pricing: { inputPer1MTokens: 1, outputPer1MTokens: 3 },
    limits: { contextWindow: 200000, maxOutputTokens: 8192 },
    status: "available",
    isLocal: false,
    lastHealthCheck: 0,
  } as ModelEntry;
}

function verdict(partial: Partial<Verdict> & { lens: string }): Verdict {
  return {
    judgeId: `${partial.lens}:${partial.modelId ?? "m"}`,
    lens: partial.lens,
    modelId: partial.modelId ?? "m",
    provider: partial.provider ?? "p",
    pass: partial.pass ?? true,
    confidence: partial.confidence ?? 0.8,
    rationale: partial.rationale ?? "",
    findings: partial.findings ?? [],
    cost: partial.cost ?? 0,
    durationMs: partial.durationMs ?? 0,
    error: partial.error,
    criteriaResults: partial.criteriaResults,
    score: partial.score,
  };
}

function contract(producerModelId?: string): AgentContract {
  return createContract({
    intent: "Verify the change is safe to merge.",
    context: "ctx",
    inputs: { task: "review the diff" },
    output: { contentType: "text" },
    acceptance: [],
    authority: {},
    provenance: { producerModelId, runId: "run_1" },
    status: "issued",
  });
}

// ── decidePanelOutcome ────────────────────────────────────────────────

describe("decidePanelOutcome", () => {
  test("majority of passes → approve", () => {
    const v = [
      verdict({ lens: "a", pass: true }),
      verdict({ lens: "b", pass: true }),
      verdict({ lens: "c", pass: false }),
    ];
    const r = decidePanelOutcome(v, { kind: "majority" });
    expect(r.decision).toBe("approve");
  });

  test("minority of passes → revise (no critical)", () => {
    const v = [
      verdict({ lens: "a", pass: true }),
      verdict({ lens: "b", pass: false }),
      verdict({ lens: "c", pass: false }),
    ];
    const r = decidePanelOutcome(v, { kind: "majority" });
    expect(r.decision).toBe("revise");
  });

  test("quorum failed with a critical finding → reject", () => {
    const v = [
      verdict({ lens: "a", pass: true }),
      verdict({
        lens: "b",
        pass: false,
        findings: [
          {
            severity: "critical",
            description: "rce",
            reviewer: "b",
          },
        ],
      }),
      verdict({ lens: "c", pass: false }),
    ];
    const r = decidePanelOutcome(v, { kind: "majority" });
    expect(r.decision).toBe("reject");
  });

  test("veto lens failing → reject even when the majority passes", () => {
    const v = [
      verdict({ lens: "correctness", pass: true }),
      verdict({ lens: "contract-fit", pass: true }),
      verdict({ lens: "security", pass: false, rationale: "sql injection" }),
    ];
    const q: QuorumSpec = { kind: "unanimous-veto", vetoLenses: ["security"] };
    const r = decidePanelOutcome(v, q);
    expect(r.decision).toBe("reject");
    expect(r.reason).toMatch(/security/);
  });

  test("unanimous-veto with security passing degrades to majority → approve", () => {
    const v = [
      verdict({ lens: "correctness", pass: true }),
      verdict({ lens: "contract-fit", pass: true }),
      verdict({ lens: "security", pass: true }),
    ];
    const q: QuorumSpec = { kind: "unanimous-veto", vetoLenses: ["security"] };
    expect(decidePanelOutcome(v, q).decision).toBe("approve");
  });

  test(">half the panel errored → revise (insufficient verification, not approval)", () => {
    const v = [
      verdict({ lens: "a", pass: true }),
      verdict({ lens: "b", pass: true, error: "spawn failed" }),
      verdict({ lens: "c", pass: true, error: "timeout" }),
    ];
    // The one valid judge passed, but 2/3 errored — must NOT approve.
    const r = decidePanelOutcome(v, { kind: "majority" });
    expect(r.decision).toBe("revise");
    expect(r.reason).toMatch(/errored/);
  });

  test("errored judges shrink the denominator (2 valid passes approve)", () => {
    const v = [
      verdict({ lens: "a", pass: true }),
      verdict({ lens: "b", pass: true }),
      verdict({ lens: "c", pass: true, error: "spawn failed" }),
    ];
    // 1/3 errored (not >half); 2 valid, both pass → majority met.
    expect(decidePanelOutcome(v, { kind: "majority" }).decision).toBe(
      "approve",
    );
  });

  test("all judges errored → revise", () => {
    const v = [
      verdict({ lens: "a", pass: false, error: "x" }),
      verdict({ lens: "b", pass: false, error: "y" }),
    ];
    expect(decidePanelOutcome(v, { kind: "majority" }).decision).toBe("revise");
  });

  test("threshold quorum honored", () => {
    const v = [
      verdict({ lens: "a", pass: true }),
      verdict({ lens: "b", pass: true }),
      verdict({ lens: "c", pass: false }),
      verdict({ lens: "d", pass: false }),
    ];
    // 2/4 = 0.5 pass; threshold 0.75 not met → revise.
    expect(
      decidePanelOutcome(v, { kind: "threshold", passFraction: 0.75 }).decision,
    ).toBe("revise");
    // threshold 0.5 met → approve.
    expect(
      decidePanelOutcome(v, { kind: "threshold", passFraction: 0.5 }).decision,
    ).toBe("approve");
  });
});

// ── selectDiverseJudges ───────────────────────────────────────────────

describe("selectDiverseJudges", () => {
  const pool = [
    model("anthropic/opus", "anthropic", 0.9),
    model("openai/gpt", "openai", 0.85),
    model("google/gemini", "google", 0.82),
    model("deepseek/v3", "deepseek", 0.7),
  ];

  test("maximizes distinct provider families", () => {
    const sel = selectDiverseJudges(
      [{ lens: "correctness" }, { lens: "security" }, { lens: "contract-fit" }],
      pool,
      { diversity: "provider" },
    );
    const providers = sel.judges.map(
      (j) => pool.find((m) => m.id === j.modelId)?.provider,
    );
    expect(new Set(providers).size).toBe(3);
    expect(sel.achievedDiversity).toBe("provider");
  });

  test("excludes the author's family when an alternative exists", () => {
    const sel = selectDiverseJudges(
      [{ lens: "correctness" }, { lens: "security" }],
      pool,
      { diversity: "provider", authorModelId: "anthropic/opus" },
    );
    const providers = sel.judges.map(
      (j) => pool.find((m) => m.id === j.modelId)?.provider,
    );
    expect(providers).not.toContain("anthropic");
  });

  test("explicit degrade to distinct models when <N providers", () => {
    const twoModelsOneProvider = [
      model("openai/a", "openai", 0.9),
      model("openai/b", "openai", 0.85),
    ];
    const sel = selectDiverseJudges(
      [{ lens: "correctness" }, { lens: "security" }],
      twoModelsOneProvider,
      { diversity: "provider" },
    );
    // Two distinct models, one provider → degraded to 'model'.
    expect(sel.achievedDiversity).toBe("model");
    expect(new Set(sel.judges.map((j) => j.modelId)).size).toBe(2);
  });

  test("explicit degrade to single-model (lens sharing) when 1 model", () => {
    const one = [model("openai/a", "openai", 0.9)];
    const sel = selectDiverseJudges(
      [{ lens: "correctness" }, { lens: "security" }, { lens: "contract-fit" }],
      one,
      { diversity: "provider" },
    );
    expect(sel.achievedDiversity).toBe("single-model");
    expect(sel.judges.every((j) => j.modelId === "openai/a")).toBe(true);
  });

  test("capability floor filters weak models, relaxes if all below", () => {
    const weak = [model("local/tiny", "local", 0.2)];
    const sel = selectDiverseJudges([{ lens: "correctness" }], weak, {
      diversity: "provider",
      capabilityFloor: 0.6,
    });
    // Floor excludes everything → relax to available so the panel isn't starved.
    expect(sel.judges[0].modelId).toBe("local/tiny");
  });

  test("pinned specs are honored and counted toward seen providers", () => {
    const sel = selectDiverseJudges(
      [
        { lens: "correctness", modelId: "anthropic/opus" },
        { lens: "security" },
      ],
      pool,
      { diversity: "provider" },
    );
    expect(sel.judges[0].modelId).toBe("anthropic/opus");
    const second = pool.find((m) => m.id === sel.judges[1].modelId);
    expect(second?.provider).not.toBe("anthropic");
  });
});

// ── runJudgePanel (mock spawn) ────────────────────────────────────────

describe("runJudgePanel", () => {
  const pool = [
    model("anthropic/opus", "anthropic", 0.9),
    model("openai/gpt", "openai", 0.85),
    model("google/gemini", "google", 0.82),
  ];

  // A permissive verdict schema stand-in.
  const verdictSchema = z.object({
    pass: z.boolean(),
    confidence: z.number(),
    rationale: z.string(),
    findings: z.array(z.any()).optional().default([]),
    score: z.number().optional(),
    criteriaResults: z.array(z.any()).optional(),
  });

  function mkDeps(spawn: PanelSpawn, deterministic?: Verdict): PanelDeps {
    return {
      spawn,
      getModels: () => pool,
      getOutputSchema: (n) =>
        n === "verdict" ? (verdictSchema as any) : undefined,
      deterministicVerdict: deterministic,
    };
  }

  test("returns a PanelDecision with one verdict per judge", async () => {
    const spawn: PanelSpawn = async (req) => ({
      text: JSON.stringify({
        pass: true,
        confidence: 0.9,
        rationale: `ok from ${req.preferredModelId}`,
      }),
      cost: 0.01,
      modelUsed: req.preferredModelId ?? "?",
      provider:
        pool.find((m) => m.id === req.preferredModelId)?.provider ?? "?",
    });
    const dec = await runJudgePanel(
      contract(),
      "diff --git a b",
      DEFAULT_PANELS["merge-gate"],
      mkDeps(spawn),
    );
    // 3 LLM judges + 1 deterministic panelist would need deterministic set;
    // here no deterministic verdict passed, so exactly 3 verdicts.
    expect(dec.verdicts.length).toBe(3);
    expect(dec.decision).toBe("approve");
    expect(dec.totalCost).toBeCloseTo(0.03, 5);
  });

  test("judges NEVER receive producer confidence or another judge's verdict", async () => {
    const seenTasks: string[] = [];
    const seenAppends: string[] = [];
    const spawn: PanelSpawn = async (req) => {
      seenTasks.push(req.task);
      seenAppends.push(req.promptAppend);
      return {
        text: JSON.stringify({ pass: true, confidence: 0.8, rationale: "ok" }),
        cost: 0,
        modelUsed: req.preferredModelId ?? "?",
        provider: "x",
      };
    };
    await runJudgePanel(
      contract("anthropic/opus"),
      "the diff",
      DEFAULT_PANELS["merge-gate"],
      mkDeps(spawn),
    );
    // No judge prompt may contain another judge's verdict or a producer
    // confidence field — the render is forJudge (confidence excluded) and
    // isolated (each spawn sees only the contract + artifact).
    for (const t of [...seenTasks, ...seenAppends]) {
      expect(t.toLowerCase()).not.toContain(
        "producer self-reported confidence",
      );
      expect(t.toLowerCase()).not.toContain("another judge");
      expect(t).not.toContain('"verdict":');
    }
  });

  test("a rejected NON-veto spawn becomes an errored judge (excluded from quorum)", async () => {
    // merge-gate judges run in order [correctness, security, contract-fit];
    // throw on the FIRST (correctness — a non-veto lens) so the errored judge
    // only shrinks the denominator without tripping the veto-coverage guard.
    let call = 0;
    const spawn: PanelSpawn = async (req) => {
      call++;
      if (call === 1) throw new Error("provider 500");
      return {
        text: JSON.stringify({ pass: true, confidence: 0.9, rationale: "ok" }),
        cost: 0.01,
        modelUsed: req.preferredModelId ?? "?",
        provider: "x",
      };
    };
    const dec = await runJudgePanel(
      contract(),
      "diff",
      DEFAULT_PANELS["merge-gate"],
      mkDeps(spawn),
    );
    const errored = dec.verdicts.filter((v) => v.error);
    expect(errored.length).toBe(1);
    // 2 valid passes out of 3, 1 errored (not >half), security valid → approve.
    expect(dec.decision).toBe("approve");
  });

  test("an errored VETO judge (security) forces revise — never a silent approve", async () => {
    // The security judge is a veto lens. If its spawn throws (provider 500) or
    // returns unparseable output, its verdict is unavailable — the panel must
    // NOT approve on the strength of the other lenses, because the security gate
    // the caller opted into was never actually evaluated.
    let call = 0;
    const spawn: PanelSpawn = async (req) => {
      call++;
      // call 2 == the security judge (order: correctness, security, contract-fit).
      if (call === 2) throw new Error("provider 500 (security judge down)");
      return {
        text: JSON.stringify({ pass: true, confidence: 0.9, rationale: "ok" }),
        cost: 0.01,
        modelUsed: req.preferredModelId ?? "?",
        provider: "x",
      };
    };
    const dec = await runJudgePanel(
      contract(),
      "diff",
      DEFAULT_PANELS["merge-gate"],
      mkDeps(spawn),
    );
    expect(dec.decision).toBe("revise");
    expect(dec.combinedRationale).toMatch(/security/i);
  });

  test("folds the deterministic verdict in as an extra panelist", async () => {
    const spawn: PanelSpawn = async (req) => ({
      text: JSON.stringify({ pass: false, confidence: 0.9, rationale: "no" }),
      cost: 0,
      modelUsed: req.preferredModelId ?? "?",
      provider: "x",
    });
    const det = verdict({
      lens: "build-test",
      modelId: "deterministic",
      provider: "deterministic",
      pass: true,
    });
    const dec = await runJudgePanel(
      contract(),
      "diff",
      DEFAULT_PANELS["merge-gate"],
      mkDeps(spawn, det),
    );
    // 3 LLM judges + 1 deterministic = 4 verdicts.
    expect(dec.verdicts.length).toBe(4);
  });

  test("unparseable judge output → errored verdict, not a silent pass", async () => {
    const spawn: PanelSpawn = async (req) => ({
      text: "I think it looks fine, no JSON here",
      cost: 0.01,
      modelUsed: req.preferredModelId ?? "?",
      provider: "x",
    });
    const dec = await runJudgePanel(
      contract(),
      "diff",
      DEFAULT_PANELS["merge-gate"],
      mkDeps(spawn),
    );
    expect(dec.verdicts.every((v) => v.error)).toBe(true);
    expect(dec.decision).toBe("revise"); // all errored → insufficient verification
  });
});

// ── runAcceptanceGatesAsync (panel gate) ──────────────────────────────

describe("runAcceptanceGatesAsync", () => {
  test("panel gate passes iff the injected panel runner approves", async () => {
    const c = createContract({
      intent: "merge safely",
      inputs: { task: "x" },
      output: { contentType: "text" },
      acceptance: [{ kind: "panel", panelConfigRef: "merge-gate" }],
      authority: {},
      provenance: {},
      status: "issued",
    });
    const report = await runAcceptanceGatesAsync(
      c,
      {},
      {
        getOutputSchema: () => undefined,
        artifact: "diff",
        resolvePanel: (ref) => (ref ? DEFAULT_PANELS[ref] : undefined),
        runPanel: async () => ({
          panelId: "pn_1",
          decision: "approve",
          verdicts: [],
          quorum: { required: 2, achieved: 2, rule: "majority" },
          dissent: [],
          combinedRationale: "Decision: APPROVE",
          totalCost: 0,
        }),
      },
    );
    expect(report.ok).toBe(true);
    expect(report.gates[0].pass).toBe(true);
    expect(report.panelDecision?.decision).toBe("approve");
  });

  test("panel gate fails the report when the panel rejects", async () => {
    const c = createContract({
      intent: "merge safely",
      inputs: { task: "x" },
      output: { contentType: "text" },
      acceptance: [{ kind: "panel", panelConfigRef: "merge-gate" }],
      authority: {},
      provenance: {},
      status: "issued",
    });
    const report = await runAcceptanceGatesAsync(
      c,
      {},
      {
        getOutputSchema: () => undefined,
        artifact: "diff",
        resolvePanel: (ref) => (ref ? DEFAULT_PANELS[ref] : undefined),
        runPanel: async () => ({
          panelId: "pn_1",
          decision: "reject",
          verdicts: [],
          quorum: { required: 2, achieved: 0, rule: "majority" },
          dissent: [],
          combinedRationale: "Decision: REJECT",
          totalCost: 0,
        }),
      },
    );
    expect(report.ok).toBe(false);
    expect(report.gates[0].pass).toBe(false);
  });

  test("panel/criterion defer when no panel runner is injected", async () => {
    const c = createContract({
      intent: "x",
      inputs: { task: "x" },
      output: { contentType: "text" },
      acceptance: [
        { kind: "panel", panelConfigRef: "merge-gate" },
        { kind: "criterion", text: "idiomatic" },
      ],
      authority: {},
      provenance: {},
      status: "issued",
    });
    const report = await runAcceptanceGatesAsync(
      c,
      {},
      {
        getOutputSchema: () => undefined,
      },
    );
    expect(report.gates.every((g) => g.deferred)).toBe(true);
    expect(report.ok).toBe(true); // deferred gates don't count against ok
  });
});

describe("buildLensPrompt", () => {
  test("security lens mentions the veto and isolation", () => {
    const p = buildLensPrompt("security");
    expect(p.toLowerCase()).toContain("security");
    expect(p.toLowerCase()).toContain("veto");
    expect(p.toLowerCase()).toContain("isolation");
  });
  test("unknown lens falls back to a generic reviewer prompt", () => {
    expect(buildLensPrompt("vibes").toLowerCase()).toContain("vibes");
  });
});
