import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "@brainst0rm/config";
import { discoverLocalModels } from "../local/discovery.js";

function configFor(baseUrl: string, apiKeyEnv?: string): ProviderConfig {
  return {
    gateway: {
      enabled: true,
      apiKeyEnv: "AI_GATEWAY_API_KEY",
      baseUrl: "https://ai-gateway.vercel.sh/v1",
    },
    ollama: {
      enabled: false,
      baseUrl: "http://localhost:11434",
      autoDiscover: false,
    },
    lmstudio: {
      enabled: true,
      baseUrl,
      autoDiscover: true,
      apiKeyEnv,
      headers: { "X-Tenant": "engineering" },
    },
    llamacpp: {
      enabled: false,
      baseUrl: "http://localhost:8080",
      autoDiscover: false,
    },
  };
}

describe("discoverLocalModels authentication and caching", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.BRAINSTORM_HOME;
    home = mkdtempSync(join(tmpdir(), "brainstorm-discovery-"));
    process.env.BRAINSTORM_HOME = home;
    delete process.env.BRAINSTORM_SKIP_DISCOVERY_CACHE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env.BRAINSTORM_HOME;
    else process.env.BRAINSTORM_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("uses the vault-aware resolver for authenticated model discovery", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "secure-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await discoverLocalModels(
      configFor("https://models.internal", "CORP_MODEL_TOKEN"),
      (name) => (name === "CORP_MODEL_TOKEN" ? "vault-secret" : null),
    );

    expect(result.models.map((model) => model.id)).toEqual([
      "lmstudio:secure-model",
    ]);
    const [, init] = fetchSpy.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer vault-secret");
    expect(headers.get("x-tenant")).toBe("engineering");
  });

  it("does not downgrade to an unauthenticated probe when a configured key is missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await discoverLocalModels(
      configFor("https://models.internal", "MISSING_TOKEN"),
      () => null,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.errors).toEqual([
      {
        provider: "lmstudio",
        error: "Configured key MISSING_TOKEN could not be resolved",
      },
    ]);
  });

  it("invalidates cached discovery when endpoint or credentials change", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        const id = url.includes("first.internal") ? "first" : "second";
        return new Response(JSON.stringify({ data: [{ id }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

    const first = await discoverLocalModels(
      configFor("https://first.internal", "TOKEN"),
      () => "token-one",
    );
    const second = await discoverLocalModels(
      configFor("https://second.internal", "TOKEN"),
      () => "token-two",
    );

    expect(first.models[0]?.id).toBe("lmstudio:first");
    expect(second.models[0]?.id).toBe("lmstudio:second");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const rawCache = readFileSync(
      join(home, ".local-providers.cache.json"),
      "utf8",
    );
    expect(rawCache).not.toContain("token-one");
    expect(rawCache).not.toContain("token-two");
  });
});
