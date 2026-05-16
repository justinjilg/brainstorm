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

  it("JSON Schema bundle — header", () => {
    // Snapshot the bundle metadata separately from per-endpoint
    // entries. The per-endpoint loop below splits the diff scope so a
    // single .describe() change in one schema doesn't explode an
    // 800-line snapshot block.
    const { endpoints: _endpoints, ...header } = out.jsonSchema;
    expect(header).toMatchSnapshot();
  });

  for (const epId of [
    "health",
    "god-mode-tools",
    "god-mode-execute",
    "platform-events",
    "platform-tenants",
  ]) {
    it(`JSON Schema — endpoint ${epId}`, () => {
      expect(out.jsonSchema.endpoints[epId]).toMatchSnapshot();
    });
  }

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
    const outcome = health!.validateResponseBody({ status: "healthy" }, 200);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((i) => i.path === "version")).toBe(true);
  });

  it("accepts a valid health response", () => {
    const health = byId.get("health");
    const outcome = health!.validateResponseBody(
      {
        status: "healthy",
        version: "1.0.0",
        product: "msp",
      },
      200,
    );
    expect(outcome.ok).toBe(true);
  });

  it("rejects a tools list whose items are missing risk_level", () => {
    const list = byId.get("god-mode-tools");
    const outcome = list!.validateResponseBody(
      {
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
      },
      200,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((i) => i.path.includes("risk_level"))).toBe(
      true,
    );
  });

  it("accepts each of the /execute response shapes via discriminator", () => {
    const exec = byId.get("god-mode-execute");
    expect(
      exec!.validateResponseBody(
        {
          success: true,
          tool: "msp.list_devices",
          data: { count: 1 },
          risk_level: "read_only",
          trace_id: "srv-1",
        },
        200,
      ).ok,
    ).toBe(true);

    expect(
      exec!.validateResponseBody(
        {
          success: false,
          error: { code: "VALIDATION", message: "bad" },
          tool: "msp.list_devices",
          trace_id: "srv-2",
        },
        400,
      ).ok,
    ).toBe(true);
  });

  it("rejects a /execute response that lacks any discriminator", () => {
    // Regression: the old "try every variant" loop would surface 3
    // concatenated failure messages, which obscured the real problem.
    // The new discriminator-first selector returns a single clear
    // "unrecognised response" outcome.
    const exec = byId.get("god-mode-execute");
    const outcome = exec!.validateResponseBody({}, 200);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toMatch(/did not match any registered shape/);
  });

  it("validates /execute success-shape strictly (success: true)", () => {
    // The pre-fix loop would have let a `{success: true, ...}` body
    // miss `risk_level` and still pass (the simulation variant only
    // checks structural shape). With discriminator-first selection,
    // missing required fields on the picked variant fail loudly.
    const exec = byId.get("god-mode-execute");
    const outcome = exec!.validateResponseBody(
      {
        success: true,
        tool: "msp.list_devices",
        data: { count: 1 },
        // risk_level intentionally missing
        trace_id: "srv-1",
      },
      200,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((i) => i.path.includes("risk_level"))).toBe(
      true,
    );
  });

  it("validates request bodies when the endpoint declares one", () => {
    const events = byId.get("platform-events");
    expect(events?.validateRequestBody).toBeDefined();
    const bad = events!.validateRequestBody!({ id: "x" });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.issues.length).toBeGreaterThan(0);
  });
});
