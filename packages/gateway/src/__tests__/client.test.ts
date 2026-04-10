/**
 * BrainstormGateway + IntelligenceAPIClient tests.
 *
 * These cover the primary surface: request construction (headers, auth,
 * body), response envelope unwrapping, admin-key switching, env-based
 * factory helpers, and error handling. `fetch` is stubbed so no network
 * I/O happens.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrainstormGateway, createGatewayClient } from "../client.js";
import {
  IntelligenceAPIClient,
  createIntelligenceClient,
} from "../intelligence-api.js";

type FetchCall = {
  url: string;
  init: RequestInit;
};

function makeFetchStub(
  responder: (
    url: string,
    init: RequestInit,
  ) => {
    status?: number;
    body: unknown;
  },
) {
  const calls: FetchCall[] = [];
  const stub = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const { status = 200, body } = responder(url, init);
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    } as unknown as Response;
  });
  return { stub, calls };
}

describe("BrainstormGateway", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends GET /v1/self with bearer auth and CSRF header", async () => {
    const { stub, calls } = makeFetchStub(() => ({
      body: { account: "acct_123", plan: "pro" },
    }));
    vi.stubGlobal("fetch", stub);

    const client = new BrainstormGateway({
      apiKey: "br_live_user",
      baseUrl: "https://example.test",
    });

    const self = await client.getSelf();

    expect(self).toEqual({ account: "acct_123", plan: "pro" });
    expect(stub).toHaveBeenCalledTimes(1);

    const call = calls[0];
    expect(call.url).toBe("https://example.test/v1/self");
    expect(call.init.method).toBe("GET");

    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer br_live_user");
    expect(headers["X-CSRF-Token"]).toMatch(/^[a-f0-9]{32}$/);
    // No body → no content-type
    expect(headers["Content-Type"]).toBeUndefined();
    expect(call.init.body).toBeUndefined();
  });

  it("unwraps array envelopes from listModels (data key)", async () => {
    const models = [
      { id: "anthropic/claude-sonnet-4.6" },
      { id: "openai/gpt-5.4" },
    ];
    const { stub } = makeFetchStub(() => ({ body: { data: models } }));
    vi.stubGlobal("fetch", stub);

    const client = new BrainstormGateway({ apiKey: "k" });
    const result = await client.listModels();

    expect(result).toEqual(models);
  });

  it("falls back through envelope keys for leaderboard (rankings key)", async () => {
    const rankings = [{ model: "a", score: 1 }];
    const { stub } = makeFetchStub(() => ({ body: { rankings } }));
    vi.stubGlobal("fetch", stub);

    const client = new BrainstormGateway({ apiKey: "k" });
    // leaderboard tries "data" then "rankings"
    const result = await client.getLeaderboard();

    expect(result).toEqual(rankings);
  });

  it("returns [] when envelope has no recognized array key", async () => {
    const { stub } = makeFetchStub(() => ({ body: { unexpected: "shape" } }));
    vi.stubGlobal("fetch", stub);

    const client = new BrainstormGateway({ apiKey: "k" });
    const result = await client.listModels();

    expect(result).toEqual([]);
  });

  it("uses adminKey for admin-scoped calls (listKeys)", async () => {
    const { stub, calls } = makeFetchStub(() => ({
      body: { keys: [{ id: "k1", name: "dev" }] },
    }));
    vi.stubGlobal("fetch", stub);

    const client = new BrainstormGateway({
      apiKey: "user-key",
      adminKey: "admin-key",
      baseUrl: "https://example.test",
    });

    const keys = await client.listKeys();

    expect(keys).toEqual([{ id: "k1", name: "dev" }]);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer admin-key");
  });

  it("POST createKey sends JSON body with defaults applied", async () => {
    const { stub, calls } = makeFetchStub(() => ({
      body: { id: "k2", name: "ci", key: "br_live_abc" },
    }));
    vi.stubGlobal("fetch", stub);

    const client = new BrainstormGateway({
      apiKey: "u",
      adminKey: "a",
    });

    const created = await client.createKey({ name: "ci" });

    expect(created).toMatchObject({ id: "k2", key: "br_live_abc" });

    const call = calls[0];
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer a");

    const body = JSON.parse(call.init.body as string);
    expect(body).toEqual({
      name: "ci",
      prefix: "br_live_",
      scopes: ["developer"],
      allowed_models: undefined,
      rate_limit_rpm: 100,
      budget_limit_usd: 50,
      budget_period: "monthly",
    });
  });

  it("reportOutcome maps success=false → outcome 'failure'", async () => {
    const { stub, calls } = makeFetchStub(() => ({ body: { ok: true } }));
    vi.stubGlobal("fetch", stub);

    const client = new BrainstormGateway({ apiKey: "k" });
    await client.reportOutcome("req_42", {
      success: false,
      error: "timeout",
      taskType: "code",
      modelUsed: "anthropic/claude-sonnet-4.6",
      cost: 0.0123,
    });

    const call = calls[0];
    expect(call.url).toMatch(/\/v1\/feedback\/req_42$/);
    const body = JSON.parse(call.init.body as string);
    expect(body.outcome).toBe("failure");
    expect(body.error).toBe("timeout");
    expect(body.task_profile).toEqual({ type: "code" });
    expect(body.model_used).toBe("anthropic/claude-sonnet-4.6");
    expect(body.cost_actual).toBe(0.0123);
  });

  it("throws a prefixed error when the server returns non-2xx", async () => {
    const { stub } = makeFetchStub(() => ({
      status: 500,
      body: { error: { message: "boom" } },
    }));
    vi.stubGlobal("fetch", stub);

    const client = new BrainstormGateway({ apiKey: "k" });

    await expect(client.getSelf()).rejects.toThrow(
      /Gateway GET \/v1\/self: boom/,
    );
  });

  it("createGatewayClient returns null without BRAINSTORM_API_KEY", () => {
    const saved = process.env.BRAINSTORM_API_KEY;
    delete process.env.BRAINSTORM_API_KEY;
    try {
      expect(createGatewayClient()).toBeNull();
    } finally {
      if (saved !== undefined) process.env.BRAINSTORM_API_KEY = saved;
    }
  });

  it("createGatewayClient wires env vars when key is present", () => {
    const savedKey = process.env.BRAINSTORM_API_KEY;
    const savedAdmin = process.env.BRAINSTORM_ADMIN_KEY;
    const savedUrl = process.env.BRAINSTORM_GATEWAY_URL;

    process.env.BRAINSTORM_API_KEY = "env-key";
    process.env.BRAINSTORM_ADMIN_KEY = "env-admin";
    process.env.BRAINSTORM_GATEWAY_URL = "https://env.example";

    try {
      const client = createGatewayClient();
      expect(client).toBeInstanceOf(BrainstormGateway);
    } finally {
      if (savedKey === undefined) delete process.env.BRAINSTORM_API_KEY;
      else process.env.BRAINSTORM_API_KEY = savedKey;
      if (savedAdmin === undefined) delete process.env.BRAINSTORM_ADMIN_KEY;
      else process.env.BRAINSTORM_ADMIN_KEY = savedAdmin;
      if (savedUrl === undefined) delete process.env.BRAINSTORM_GATEWAY_URL;
      else process.env.BRAINSTORM_GATEWAY_URL = savedUrl;
    }
  });
});

describe("IntelligenceAPIClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("submitTrajectory POSTs the submission and returns true on success", async () => {
    const { stub, calls } = makeFetchStub(() => ({ body: { ok: true } }));
    vi.stubGlobal("fetch", stub);

    const client = new IntelligenceAPIClient("https://api.test", "k");
    const ok = await client.submitTrajectory({
      sessionId: "s1",
      projectFramework: "nextjs",
      events: [{ type: "turn" }],
      totalCost: 0.05,
      totalTurns: 3,
      success: true,
    });

    expect(ok).toBe(true);
    expect(calls[0].url).toBe("https://api.test/v1/agent/trajectory");
    expect(calls[0].init.method).toBe("POST");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.sessionId).toBe("s1");
    expect(body.projectFramework).toBe("nextjs");
  });

  it("submitTrajectory swallows errors and returns false", async () => {
    const { stub } = makeFetchStub(() => ({
      status: 503,
      body: { error: { message: "unavailable" } },
    }));
    vi.stubGlobal("fetch", stub);

    const client = new IntelligenceAPIClient("https://api.test", "k");
    const ok = await client.submitTrajectory({
      sessionId: "s1",
      projectFramework: "nextjs",
      events: [],
      totalCost: 0,
      totalTurns: 0,
      success: false,
    });

    expect(ok).toBe(false);
  });

  it("forecastCost URL-encodes query params", async () => {
    const forecast = {
      taskType: "code gen",
      complexity: "high",
      estimatedCost: 0.42,
      range: [0.2, 0.6],
      basedOnSamples: 17,
    };
    const { stub, calls } = makeFetchStub(() => ({ body: forecast }));
    vi.stubGlobal("fetch", stub);

    const client = new IntelligenceAPIClient("https://api.test", "k");
    const result = await client.forecastCost("code gen", "high", "next/js");

    expect(result).toEqual(forecast);
    const url = calls[0].url;
    expect(url).toContain("taskType=code%20gen");
    expect(url).toContain("complexity=high");
    expect(url).toContain("framework=next%2Fjs");
  });

  it("createIntelligenceClient returns null without api key", () => {
    const saved = process.env.BRAINSTORM_API_KEY;
    delete process.env.BRAINSTORM_API_KEY;
    try {
      expect(createIntelligenceClient()).toBeNull();
    } finally {
      if (saved !== undefined) process.env.BRAINSTORM_API_KEY = saved;
    }
  });
});
