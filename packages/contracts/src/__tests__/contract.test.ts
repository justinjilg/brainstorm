import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  AgentContractSchema,
  createContract,
  renderContractPrompt,
  validateContractOutput,
  runAcceptanceGates,
  type CreateContractInput,
} from "../index.js";
import type { AgentContract } from "@brainst0rm/shared";

const baseInput: CreateContractInput = {
  intent: "Add a health endpoint so the load balancer can probe liveness.",
  context: "The server lives in packages/server; no health route exists yet.",
  nonGoals: ["Do not add auth to the health route"],
  inputs: { task: "Implement GET /health returning 200 {status:'ok'}." },
  output: { contentType: "json", schemaRef: "code-changes" },
  acceptance: [{ kind: "schema" }],
  authority: { readOnly: false, maxSteps: 8 },
  provenance: { producerModelId: "opus-4-8", runId: "run_1", taskId: "task_1" },
};

// A tiny local schema registry so tests don't couple to agents' real one.
const testSchemas: Record<string, z.ZodType> = {
  "code-changes": z.object({
    summary: z.string(),
    confidence: z.number().min(0).max(1),
  }),
};
const getSchema = (name: string) => testSchemas[name];

describe("AgentContractSchema", () => {
  test("accepts a well-formed contract", () => {
    const contract = createContract(baseInput);
    expect(AgentContractSchema.safeParse(contract).success).toBe(true);
  });

  test("rejects an empty intent", () => {
    const contract = { ...createContract(baseInput), intent: "   " };
    const res = AgentContractSchema.safeParse(contract);
    expect(res.success).toBe(false);
  });

  test("createContract throws on empty intent", () => {
    expect(() => createContract({ ...baseInput, intent: "" })).toThrow();
  });
});

describe("createContract", () => {
  test("assigns id, provenance.createdAt, and default status", () => {
    const contract = createContract({
      intent: baseInput.intent,
      inputs: baseInput.inputs,
    });
    expect(contract.id).toMatch(/^ct_/);
    expect(contract.provenance.createdAt).toBeGreaterThan(0);
    expect(contract.status).toBe("draft");
    expect(contract.version).toBe(1);
  });

  test("preserves supplied provenance.createdAt and status", () => {
    const contract = createContract({
      ...baseInput,
      status: "issued",
      provenance: { ...baseInput.provenance, createdAt: 123 },
    });
    expect(contract.provenance.createdAt).toBe(123);
    expect(contract.status).toBe("issued");
  });
});

describe("renderContractPrompt", () => {
  test("includes all sections", () => {
    const contract = createContract(baseInput);
    const rendered = renderContractPrompt(contract);
    for (const section of [
      "## Intent",
      "## Context",
      "## Non-goals",
      "## Task",
      "## Deliverable schema",
      "## Acceptance criteria",
      "## Authority",
    ]) {
      expect(rendered).toContain(section);
    }
    expect(rendered).toContain(baseInput.intent);
  });

  test("consumer render includes producer confidence; judge render omits it", () => {
    const contract = createContract(baseInput);
    const consumer = renderContractPrompt(contract, {
      producerConfidence: 0.9,
    });
    const judge = renderContractPrompt(contract, {
      forJudge: true,
      producerConfidence: 0.9,
    });
    expect(consumer).toContain("confidence");
    expect(consumer).toContain("0.9");
    expect(judge).not.toContain("confidence");
    // Judge render also withholds producer identity to avoid anchoring.
    expect(judge).not.toContain("opus-4-8");
  });
});

describe("validateContractOutput", () => {
  test("parses a valid JSON block against a registered schema", () => {
    const contract = createContract(baseInput);
    const raw =
      'Here is the result:\n```json\n{"summary":"done","confidence":0.8}\n```';
    const res = validateContractOutput(contract, raw, getSchema);
    expect(res.ok).toBe(true);
    expect(res.parsed).toEqual({ summary: "done", confidence: 0.8 });
  });

  test("reports Zod errors on invalid output", () => {
    const contract = createContract(baseInput);
    const raw = '```json\n{"summary":"done","confidence":5}\n```';
    const res = validateContractOutput(contract, raw, getSchema);
    expect(res.ok).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
  });

  test("reports missing JSON block", () => {
    const contract = createContract(baseInput);
    const res = validateContractOutput(contract, "no json here", getSchema);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/no JSON block/i);
  });

  test("no schemaRef is trivially valid", () => {
    const contract = createContract({
      ...baseInput,
      output: { contentType: "text" },
    });
    const res = validateContractOutput(contract, "anything", getSchema);
    expect(res.ok).toBe(true);
  });

  test("unknown schemaRef fails", () => {
    const contract = createContract({
      ...baseInput,
      output: { contentType: "json", schemaRef: "does-not-exist" },
    });
    const res = validateContractOutput(contract, "```json\n{}\n```", getSchema);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/unknown output schema/i);
  });
});

describe("runAcceptanceGates", () => {
  test("schema gate passes on valid output", () => {
    const contract = createContract({
      ...baseInput,
      acceptance: [{ kind: "schema" }],
    });
    const report = runAcceptanceGates(
      contract,
      { rawText: '```json\n{"summary":"x","confidence":0.5}\n```' },
      { getOutputSchema: getSchema },
    );
    expect(report.ok).toBe(true);
    expect(report.gates[0].pass).toBe(true);
  });

  test("schema gate fails on invalid output", () => {
    const contract = createContract({
      ...baseInput,
      acceptance: [{ kind: "schema" }],
    });
    const report = runAcceptanceGates(
      contract,
      { rawText: '```json\n{"summary":"x"}\n```' },
      { getOutputSchema: getSchema },
    );
    expect(report.ok).toBe(false);
    expect(report.gates[0].pass).toBe(false);
  });

  test("command gate passes when the command exits 0", () => {
    const contract = createContract({
      ...baseInput,
      acceptance: [{ kind: "command", cmd: "node -e 0" }],
    });
    const report = runAcceptanceGates(
      contract,
      {},
      { getOutputSchema: getSchema },
    );
    expect(report.gates[0].pass).toBe(true);
    expect(report.ok).toBe(true);
  });

  test("command gate fails when the command exits non-zero", () => {
    const contract = createContract({
      ...baseInput,
      acceptance: [{ kind: "command", cmd: "node -e process.exit(1)" }],
    });
    const report = runAcceptanceGates(
      contract,
      {},
      { getOutputSchema: getSchema },
    );
    expect(report.gates[0].pass).toBe(false);
    expect(report.ok).toBe(false);
  });

  test("files_touched_within passes for files inside allowed paths", () => {
    const contract = createContract({
      ...baseInput,
      acceptance: [{ kind: "files_touched_within", paths: ["src", "docs"] }],
    });
    const report = runAcceptanceGates(
      contract,
      { filesTouched: ["src/a.ts", "docs/readme.md"] },
      { getOutputSchema: getSchema },
    );
    expect(report.gates[0].pass).toBe(true);
    expect(report.ok).toBe(true);
  });

  test("files_touched_within fails for files outside allowed paths", () => {
    const contract = createContract({
      ...baseInput,
      acceptance: [{ kind: "files_touched_within", paths: ["src"] }],
    });
    const report = runAcceptanceGates(
      contract,
      { filesTouched: ["src/a.ts", "secrets/key.pem"] },
      { getOutputSchema: getSchema },
    );
    expect(report.gates[0].pass).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.gates[0].detail).toContain("secrets/key.pem");
  });

  test("string-prefix paths are not treated as containment", () => {
    const contract = createContract({
      ...baseInput,
      acceptance: [{ kind: "files_touched_within", paths: ["src/ab"] }],
    });
    const report = runAcceptanceGates(
      contract,
      { filesTouched: ["src/a/file.ts"] },
      { getOutputSchema: getSchema },
    );
    expect(report.gates[0].pass).toBe(false);
  });

  test("panel and criterion gates are deferred, not counted against ok", () => {
    const contract = createContract({
      ...baseInput,
      acceptance: [
        { kind: "panel", panelConfigRef: "merge-gate" },
        { kind: "criterion", text: "The design is idiomatic." },
      ],
    });
    const report = runAcceptanceGates(
      contract,
      {},
      { getOutputSchema: getSchema },
    );
    expect(report.ok).toBe(true);
    expect(report.gates.every((g) => g.deferred)).toBe(true);
    expect(report.gates.every((g) => g.pass === null)).toBe(true);
  });
});
