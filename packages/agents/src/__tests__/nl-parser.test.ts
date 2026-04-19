import { describe, it, expect } from "vitest";
import { parseAgentNL, resolveModelAlias } from "../nl-parser.js";

describe("parseAgentNL", () => {
  it("parses 'architect using opus with $30 budget'", () => {
    const { intent } = parseAgentNL("architect using opus with $30 budget");
    expect(intent).not.toBeNull();
    expect(intent!.role).toBe("architect");
    expect(intent!.modelId).toBe("anthropic/claude-opus-4-6");
    expect(intent!.budget).toBe(30);
  });

  it("parses 'coder using gpt-5.4 with $20 budget'", () => {
    const { intent } = parseAgentNL("coder using gpt-5.4 with $20 budget");
    expect(intent).not.toBeNull();
    expect(intent!.role).toBe("coder");
    expect(intent!.modelId).toBe("openai/gpt-5.4");
    expect(intent!.budget).toBe(20);
  });

  it("parses 'reviewer using sonnet'", () => {
    const { intent } = parseAgentNL("reviewer using sonnet");
    expect(intent).not.toBeNull();
    expect(intent!.role).toBe("reviewer");
    expect(intent!.modelId).toBe("anthropic/claude-sonnet-4-5-20250620");
  });

  it("detects PII guardrails", () => {
    const { intent } = parseAgentNL("coder with PII guardrails using opus");
    expect(intent).not.toBeNull();
    expect(intent!.guardrailsPii).toBe(true);
  });

  it("detects daily budget", () => {
    const { intent } = parseAgentNL(
      "analyst using gemini with $50 daily budget",
    );
    expect(intent).not.toBeNull();
    expect(intent!.budgetDaily).toBe(50);
    // Pre-fix, the per-workflow regex ALSO matched the same `$50`,
    // double-setting `budget=50`. "daily budget" means daily, not
    // both daily and per-workflow.
    expect(intent!.budget).toBeUndefined();
  });

  it("detects per-workflow budget without double-setting daily", () => {
    const { intent } = parseAgentNL("architect using opus with $30 budget");
    expect(intent).not.toBeNull();
    expect(intent!.budget).toBe(30);
    expect(intent!.budgetDaily).toBeUndefined();
  });

  it("detects both when both are explicit", () => {
    // Each $-amount belongs to its specific modifier.
    const { intent } = parseAgentNL(
      "coder using sonnet with $10 budget and $50 daily",
    );
    expect(intent).not.toBeNull();
    expect(intent!.budget).toBe(10);
    expect(intent!.budgetDaily).toBe(50);
  });

  it("defaults to auto:quality model when none specified", () => {
    const { intent } = parseAgentNL("architect with $10 budget");
    expect(intent).not.toBeNull();
    expect(intent!.modelId).toBe("auto:quality");
  });

  it("returns null intent for empty/ambiguous input", () => {
    const { intent, suggestion } = parseAgentNL("hello");
    expect(intent).toBeNull();
    expect(suggestion).toBeDefined();
    expect(suggestion).toContain("Roles:");
  });

  it("matches role aliases", () => {
    expect(parseAgentNL("planner using opus").intent!.role).toBe("architect");
    expect(parseAgentNL("developer using opus").intent!.role).toBe("coder");
    expect(parseAgentNL("programmer using opus").intent!.role).toBe("coder");
    expect(parseAgentNL("auditor using opus").intent!.role).toBe("reviewer");
    expect(parseAgentNL("troubleshooter using opus").intent!.role).toBe(
      "debugger",
    );
    expect(parseAgentNL("explainer using opus").intent!.role).toBe("analyst");
  });

  it("parses fractional budget", () => {
    const { intent } = parseAgentNL("coder with $0.50 budget");
    expect(intent).not.toBeNull();
    expect(intent!.budget).toBe(0.5);
  });
});

describe("resolveModelAlias", () => {
  it("resolves known aliases", () => {
    expect(resolveModelAlias("opus")).toBe("anthropic/claude-opus-4-6");
    expect(resolveModelAlias("sonnet")).toBe(
      "anthropic/claude-sonnet-4-5-20250620",
    );
    expect(resolveModelAlias("gpt-5.4")).toBe("openai/gpt-5.4");
    expect(resolveModelAlias("flash")).toBe("google/gemini-2.5-flash");
    expect(resolveModelAlias("deepseek")).toBe("deepseek/deepseek-chat");
  });

  it("passes through unknown aliases unchanged", () => {
    expect(resolveModelAlias("my-custom-model")).toBe("my-custom-model");
  });

  it("is case-insensitive", () => {
    expect(resolveModelAlias("OPUS")).toBe("anthropic/claude-opus-4-6");
    expect(resolveModelAlias("Sonnet")).toBe(
      "anthropic/claude-sonnet-4-5-20250620",
    );
  });
});
