/**
 * Snapshot tests for the contract compiler.
 *
 * BR's compiler ships with golden tests that diff regenerated outputs
 * against committed snapshots; the same pattern applies here. If a
 * schema change is intentional, regenerate the snapshots with
 * `vitest -u`. If the change is unintentional, the test fails CI
 * before the drift reaches downstream consumers.
 *
 * The snapshots intentionally cover all 5 generator outputs at once.
 * Pydantic and Go are stubs today; their snapshots are still
 * versioned so the Stage-2b expansion can diff against the stub.
 */

import { describe, expect, it } from "vitest";
import { compileContract } from "../compile.js";

describe("contract compiler — snapshots", () => {
  const out = compileContract();

  it("endpoint registry is stable", () => {
    expect(
      out.endpoints.map((e) => ({
        id: e.id,
        method: e.method,
        path: e.path,
        auth: e.auth,
      })),
    ).toMatchSnapshot();
  });

  it("markdown sections per endpoint", () => {
    expect(
      out.markdown.map((s) => ({ id: s.id, markdown: s.markdown })),
    ).toMatchSnapshot();
  });

  it("JSON Schema bundle", () => {
    expect(out.jsonSchema).toMatchSnapshot();
  });

  it("validator plan summary", () => {
    expect(
      out.validator.map((v) => ({
        id: v.id,
        method: v.method,
        path: v.path,
        auth: v.auth,
        acceptStatuses: v.acceptStatuses,
        hasRequestValidator: typeof v.validateRequestBody === "function",
      })),
    ).toMatchSnapshot();
  });

  it("pydantic stub file list", () => {
    expect(out.pydantic.map((f) => f.path)).toMatchSnapshot();
  });

  it("go stub file list", () => {
    expect(out.go.map((f) => f.path)).toMatchSnapshot();
  });
});

describe("validator plans — shape checking", () => {
  const plans = compileContract().validator;
  const byId = new Map(plans.map((p) => [p.id, p]));

  it("rejects a health response missing required fields", () => {
    const health = byId.get("health");
    expect(health).toBeDefined();
    const outcome = health!.validateResponseBody({ status: "healthy" });
    expect(outcome.ok).toBe(false);
    expect(outcome.issues?.some((i) => i.path === "version")).toBe(true);
  });

  it("accepts a valid health response", () => {
    const health = byId.get("health");
    const outcome = health!.validateResponseBody({
      status: "healthy",
      version: "1.0.0",
      product: "msp",
    });
    expect(outcome.ok).toBe(true);
  });

  it("rejects a tools list whose items are missing risk_level", () => {
    const list = byId.get("god-mode-tools");
    const outcome = list!.validateResponseBody({
      product: "msp",
      version: "1.0.0",
      tool_count: 1,
      tools: [
        {
          name: "msp.list_devices",
          domain: "endpoint-management",
          product: "msp",
          description: "x",
          parameters: { type: "object" },
          requires_changeset: false,
          // risk_level intentionally missing
        },
      ],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.issues?.some((i) => i.path.includes("risk_level"))).toBe(
      true,
    );
  });

  it("accepts any of the three /execute response shapes", () => {
    const exec = byId.get("god-mode-execute");
    expect(
      exec!.validateResponseBody({
        success: true,
        tool: "msp.list_devices",
        data: { count: 1 },
        risk_level: "read_only",
        trace_id: "srv-1",
      }).ok,
    ).toBe(true);

    expect(
      exec!.validateResponseBody({
        success: false,
        error: { code: "VALIDATION", message: "bad" },
        tool: "msp.list_devices",
        trace_id: "srv-2",
      }).ok,
    ).toBe(true);
  });

  it("validates request bodies when the endpoint declares one", () => {
    const events = byId.get("platform-events");
    expect(events?.validateRequestBody).toBeDefined();
    const bad = events!.validateRequestBody!({ id: "x" });
    expect(bad.ok).toBe(false);
    expect(bad.issues?.length).toBeGreaterThan(0);
  });
});
