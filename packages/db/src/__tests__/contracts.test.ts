import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";

import { getTestDb } from "../index.js";
import { ContractRepository, VerdictRepository } from "../repositories.js";
import type { AgentContract, PanelDecision, Verdict } from "@brainst0rm/shared";

let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function makeContract(): AgentContract {
  return {
    id: "ct_test123",
    version: 1,
    intent: "Add a health endpoint.",
    context: "Server package needs a liveness probe.",
    nonGoals: ["No auth on the route"],
    inputs: { task: "Implement GET /health", artifacts: ["packages/server"] },
    output: { schemaRef: "code-changes", contentType: "json" },
    acceptance: [
      { kind: "schema" },
      { kind: "command", cmd: "npm run -s build" },
    ],
    authority: {
      readOnly: false,
      maxSteps: 8,
      toolAllowlist: ["read", "write"],
    },
    provenance: {
      producerModelId: "opus-4-8",
      runId: "run_1",
      taskId: "task_1",
      createdAt: 1_700_000_000,
    },
    status: "issued",
  };
}

describe("migrations 035/036", () => {
  test("apply cleanly and create the new tables + column", () => {
    db = getTestDb();
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "agent_contracts",
        "panel_verdicts",
        "panel_decisions",
      ]),
    );
    const cols = (
      db.prepare("PRAGMA table_info(orchestration_tasks)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).toContain("contract_id");
  });
});

describe("ContractRepository", () => {
  test("round-trips a contract", () => {
    db = getTestDb();
    const repo = new ContractRepository(db);
    const contract = makeContract();
    repo.save(contract);

    const loaded = repo.getById(contract.id);
    expect(loaded).toBeDefined();
    expect(loaded).toEqual(contract);
  });

  test("updateStatus + listByRun", () => {
    db = getTestDb();
    const repo = new ContractRepository(db);
    const contract = makeContract();
    repo.save(contract);
    repo.updateStatus(contract.id, "fulfilled");
    expect(repo.getById(contract.id)?.status).toBe("fulfilled");
    expect(repo.listByRun("run_1").map((c) => c.id)).toEqual([contract.id]);
  });
});

describe("VerdictRepository", () => {
  test("round-trips verdicts and a decision", () => {
    db = getTestDb();
    const repo = new VerdictRepository(db);
    const panelId = "panel_abc";

    const v1: Verdict = {
      judgeId: "correctness:opus-4-8",
      lens: "correctness",
      modelId: "opus-4-8",
      provider: "anthropic",
      pass: true,
      score: 0.9,
      confidence: 0.85,
      rationale: "Looks correct.",
      findings: [
        {
          severity: "low",
          description: "minor nit",
          reviewer: "correctness:opus-4-8",
        },
      ],
      criteriaResults: [{ criterion: "builds", pass: true, evidence: "green" }],
      cost: 0.01,
      durationMs: 1200,
    };
    const v2: Verdict = {
      judgeId: "security:gpt-5-4",
      lens: "security",
      modelId: "gpt-5-4",
      provider: "openai",
      pass: false,
      confidence: 0.7,
      rationale: "Missing input validation.",
      findings: [],
      cost: 0.02,
      durationMs: 900,
    };

    repo.recordVerdict(v1, {
      panelId,
      contractId: "ct_test123",
      runId: "run_1",
    });
    repo.recordVerdict(v2, {
      panelId,
      contractId: "ct_test123",
      runId: "run_1",
    });

    const decision: PanelDecision = {
      panelId,
      decision: "revise",
      verdicts: [],
      quorum: { required: 2, achieved: 1, rule: "majority" },
      dissent: ["Missing input validation."],
      combinedRationale: "1/2 passed; security flagged validation.",
      totalCost: 0.03,
    };
    repo.recordDecision(decision, { contractId: "ct_test123", runId: "run_1" });

    const verdicts = repo.listVerdicts(panelId);
    expect(verdicts).toHaveLength(2);
    expect(verdicts.map((v) => v.lens).sort()).toEqual([
      "correctness",
      "security",
    ]);
    expect(verdicts.find((v) => v.lens === "correctness")?.pass).toBe(true);
    expect(verdicts.find((v) => v.lens === "security")?.pass).toBe(false);

    const loaded = repo.getDecision(panelId);
    expect(loaded?.decision).toBe("revise");
    expect(loaded?.quorum).toEqual({
      required: 2,
      achieved: 1,
      rule: "majority",
    });
    expect(loaded?.dissent).toEqual(["Missing input validation."]);
    expect(loaded?.verdicts).toHaveLength(2);
  });
});
