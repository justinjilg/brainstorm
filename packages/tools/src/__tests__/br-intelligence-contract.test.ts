import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach, vi } from "vitest";
import { createDefaultToolRegistry } from "../index.js";
import {
  brBudgetTool,
  brHealthTool,
  brInsightsTool,
  brLeaderboardTool,
  brMemorySearchTool,
  brMemoryStoreTool,
  brModelsTool,
  brStatusTool,
} from "../builtin/br-intelligence.js";
import type { BrainstormToolDef } from "../base.js";

const AUTH_REQUIRED_TOOLS = [
  brStatusTool,
  brBudgetTool,
  brLeaderboardTool,
  brInsightsTool,
  brModelsTool,
  brMemorySearchTool,
  brMemoryStoreTool,
];

const READ_ONLY_TOOLS = [
  brHealthTool,
  brStatusTool,
  brBudgetTool,
  brLeaderboardTool,
  brInsightsTool,
  brModelsTool,
  brMemorySearchTool,
];

const ALL_BR_TOOLS = [...READ_ONLY_TOOLS, brMemoryStoreTool];

const EXPECTED_TOOL_SHAPE = [
  {
    tool: brHealthTool,
    name: "br_health",
    permission: "auto",
    validInput: {},
    paths: ["/health"],
  },
  {
    tool: brStatusTool,
    name: "br_status",
    permission: "auto",
    validInput: {},
    paths: ["/v1/self"],
  },
  {
    tool: brBudgetTool,
    name: "br_budget",
    permission: "auto",
    validInput: {},
    paths: ["/v1/budget/status", "/v1/budget/forecast"],
  },
  {
    tool: brModelsTool,
    name: "br_models",
    permission: "auto",
    validInput: {},
    paths: ["/v1/models"],
  },
  {
    tool: brLeaderboardTool,
    name: "br_leaderboard",
    permission: "auto",
    validInput: { sort: "quality" },
    paths: ["/v1/intelligence/rankings"],
  },
  {
    tool: brInsightsTool,
    name: "br_insights",
    permission: "auto",
    validInput: {},
    paths: ["/v1/insights/optimize"],
  },
  {
    tool: brMemorySearchTool,
    name: "br_memory_search",
    permission: "auto",
    validInput: { query: "business harness" },
    invalidInput: {},
    paths: ["/v1/memory/query"],
  },
  {
    tool: brMemoryStoreTool,
    name: "br_memory_store",
    permission: "confirm",
    validInput: { text: "sandbox-only memory", block: "project" },
    invalidInput: { text: "sandbox-only memory", block: "invalid" },
    paths: ["/v1/memory/store"],
  },
] as const;

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

function contractMapPaths(): Set<string> {
  const raw = readFileSync(
    path.join(REPO_ROOT, "artifacts/br-business-contract-map.json"),
    "utf8",
  );
  const map = JSON.parse(raw) as {
    routes?: Array<{ target?: string; path?: string }>;
  };
  return new Set(
    (map.routes ?? [])
      .filter((route) => route.target === "br")
      .map((route) => route.path)
      .filter((route): route is string => Boolean(route)),
  );
}

function setBrKey(value: string | undefined) {
  if (value === undefined) {
    delete process.env.BRAINSTORM_API_KEY;
    delete process.env._BR_RESOLVED_KEY;
  } else {
    process.env.BRAINSTORM_API_KEY = value;
    delete process.env._BR_RESOLVED_KEY;
  }
}

function containsNoKeyError(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.error === "No BrainstormRouter API key available.") return true;
  return Object.values(record).some((entry) => containsNoKeyError(entry));
}

function stubJsonFetch(status: number, body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return vi.fn(async () => {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => text,
    } as Response;
  });
}

describe("BrainstormRouter native tool contract", () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const savedKey = process.env.BRAINSTORM_API_KEY;
  const savedResolvedKey = process.env._BR_RESOLVED_KEY;

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
    if (savedKey === undefined) delete process.env.BRAINSTORM_API_KEY;
    else process.env.BRAINSTORM_API_KEY = savedKey;
    if (savedResolvedKey === undefined) delete process.env._BR_RESOLVED_KEY;
    else process.env._BR_RESOLVED_KEY = savedResolvedKey;
  });

  it("keeps stable tool names, permission posture, descriptions, and schemas", () => {
    for (const spec of EXPECTED_TOOL_SHAPE) {
      expect(spec.tool.name).toBe(spec.name);
      expect(spec.tool.permission).toBe(spec.permission);
      expect(spec.tool.description.length).toBeGreaterThan(40);
      expect(spec.tool.description).toMatch(
        /BrainstormRouter|BR|model|memory|budget/i,
      );
      expect(spec.tool.inputSchema.safeParse(spec.validInput).success).toBe(
        true,
      );
      if ("invalidInput" in spec) {
        expect(spec.tool.inputSchema.safeParse(spec.invalidInput).success).toBe(
          false,
        );
      }
    }
  });

  it("keeps read-only tools auto and br_memory_store confirmation-gated", () => {
    for (const tool of READ_ONLY_TOOLS) {
      expect(tool.permission, `${tool.name} should remain auto`).toBe("auto");
    }
    expect(brMemoryStoreTool.permission).toBe("confirm");
  });

  it("keeps every native BR route represented in the bounded contract map", () => {
    const paths = contractMapPaths();
    for (const spec of EXPECTED_TOOL_SHAPE) {
      for (const route of spec.paths) {
        expect(
          paths.has(route),
          `${spec.name} route ${route} missing from br-business-contract-map`,
        ).toBe(true);
      }
    }
  });

  it("returns structured errors for auth-required tools when no BR key is available", async () => {
    setBrKey(undefined);
    for (const tool of AUTH_REQUIRED_TOOLS) {
      const input =
        EXPECTED_TOOL_SHAPE.find((spec) => spec.tool === tool)?.validInput ??
        {};
      const result = await tool.execute(input);
      expect(
        containsNoKeyError(result),
        `${tool.name} returned ${result}`,
      ).toBe(true);
    }
  });

  it("bounds non-2xx BR response text in tool errors", async () => {
    setBrKey("br_test_static_contract_key");
    const longBody = "x".repeat(500);
    globalThis.fetch = stubJsonFetch(503, longBody) as typeof fetch;

    const result = await brStatusTool.execute({});

    expect(result).toMatchObject({
      error: expect.stringContaining("BR API 503"),
    });
    expect((result as { error: string }).error).toContain("x".repeat(200));
    expect((result as { error: string }).error).not.toContain("x".repeat(201));
  });

  it("uses AbortSignal.timeout and sends the expected native BR routes", async () => {
    setBrKey("br_test_static_contract_key");
    const calls: Array<{ url: string; method: string; hasSignal: boolean }> =
      [];
    const timeoutSignal = new AbortController().signal;
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeoutSignal);
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      calls.push({
        url,
        method: init?.method ?? "GET",
        hasSignal: init?.signal === timeoutSignal,
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => JSON.stringify({ ok: true }),
      } as Response;
    }) as typeof fetch;

    await brHealthTool.execute({});
    await brStatusTool.execute({});
    await brBudgetTool.execute({});
    await brModelsTool.execute({});
    await brLeaderboardTool.execute({ sort: "quality" });
    await brInsightsTool.execute({});
    await brMemorySearchTool.execute({ query: "business harness" });
    await brMemoryStoreTool.execute({ text: "sandbox-only", block: "project" });

    expect(timeoutSpy).toHaveBeenCalled();
    expect(timeoutSpy.mock.calls.every(([ms]) => ms === 10_000)).toBe(true);
    expect(calls.every((call) => call.hasSignal)).toBe(true);
    expect(
      calls.map((call) => `${call.method} ${new URL(call.url).pathname}`),
    ).toEqual([
      "GET /health",
      "GET /v1/self",
      "GET /v1/budget/status",
      "GET /v1/budget/forecast",
      "GET /v1/models",
      "GET /v1/intelligence/rankings",
      "GET /v1/insights/optimize",
      "POST /v1/memory/query",
      "POST /v1/memory/store",
    ]);
  });

  it("uses the resolved vault key over the raw BR env key", async () => {
    process.env.BRAINSTORM_API_KEY = "br_test_env_key";
    process.env._BR_RESOLVED_KEY = "br_test_resolved_key";
    globalThis.fetch = stubJsonFetch(200, { ok: true }) as typeof fetch;

    await brStatusTool.execute({});

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { Authorization: "Bearer br_test_resolved_key" },
      }),
    );
  });

  it("registers the native BR tool family in the default registry", () => {
    const registry = createDefaultToolRegistry();
    const names = new Set(
      registry.getAll().map((tool: BrainstormToolDef) => tool.name),
    );
    for (const tool of ALL_BR_TOOLS) {
      expect(names.has(tool.name), `${tool.name} missing from registry`).toBe(
        true,
      );
    }
  });
});
