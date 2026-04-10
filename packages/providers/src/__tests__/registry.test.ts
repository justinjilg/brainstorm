import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createProviderRegistry } from "../registry.js";
import { CLOUD_MODELS } from "../cloud/models.js";
import type { BrainstormConfig } from "@brainst0rm/config";

vi.mock("../local/discovery.js", () => ({
  discoverLocalModels: vi.fn(async () => ({ models: [] })),
}));

const createConfig = () => ({
  providers: {
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
      enabled: false,
      baseUrl: "http://localhost:1234",
      autoDiscover: false,
    },
    llamacpp: {
      enabled: false,
      baseUrl: "http://localhost:8080",
      autoDiscover: false,
    },
  },
  models: [],
  general: {
    defaultStrategy: "combined",
    confirmTools: true,
    defaultPermissionMode: "confirm",
    theme: "dark",
    maxSteps: 10,
    outputStyle: "concise",
    costSafetyMargin: 1.3,
    loopDetector: {
      readThreshold: 4,
      repeatThreshold: 3,
    },
    subagentIsolation: "none",
  },
  shell: {
    defaultTimeout: 120_000,
    maxOutputBytes: 50_000,
    sandbox: "restricted",
    containerImage: "node:22-slim",
    containerTimeout: 120_000,
  },
  budget: {
    hardLimit: false,
  },
  routing: { rules: [] },
  agents: [],
  workflows: [],
  mcp: {
    servers: [],
  },
  permissions: {
    allowlist: [],
    denylist: [],
  },
  memory: {
    maxBytes: 102400,
  },
  telemetry: {
    enabled: false,
    serviceName: "brainstorm",
  },
});

const createResolvedKeys = (entries: Record<string, string | null>) => {
  const keys = new Map(Object.entries(entries));
  return {
    get(name: string) {
      return keys.get(name) ?? null;
    },
  };
};

describe("createProviderRegistry", () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    process.env = { ...envBackup };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.BRAINSTORM_API_KEY;
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it("creates an empty cloud registry when no provider keys are resolved", async () => {
    const registry = await createProviderRegistry(
      createConfig() as any,
      createResolvedKeys({}),
    );

    expect(registry.hasBrainstormSaaS).toBe(false);
    expect(registry.models).toEqual([]);
  });

  it("registers provider-backed cloud models when an API key is available", async () => {
    const registry = await createProviderRegistry(
      createConfig() as any,
      createResolvedKeys({ ANTHROPIC_API_KEY: "test-key" }),
    );

    const anthropicModels = registry.models.filter(
      (model) => model.provider === "anthropic",
    );

    expect(anthropicModels.length).toBeGreaterThan(0);
    expect(anthropicModels.every((model) => model.status === "available")).toBe(
      true,
    );
  });

  it("does not register cloud models for providers without API keys", async () => {
    const registry = await createProviderRegistry(
      createConfig() as any,
      createResolvedKeys({ OPENAI_API_KEY: null }),
    );

    expect(registry.models.some((model) => model.provider === "openai")).toBe(
      false,
    );
  });

  it("looks up models by ID", async () => {
    const targetModel = CLOUD_MODELS.find(
      (model) => model.provider === "anthropic",
    );
    expect(targetModel).toBeDefined();

    const registry = await createProviderRegistry(
      createConfig() as any,
      createResolvedKeys({ ANTHROPIC_API_KEY: "test-key" }),
    );

    expect(registry.getModel(targetModel!.id)).toMatchObject({
      id: targetModel!.id,
      provider: "anthropic",
    });
    expect(registry.getModel("anthropic/does-not-exist")).toBeUndefined();
  });

  it("supports listing models by provider via registry.models", async () => {
    const registry = await createProviderRegistry(
      createConfig() as any,
      createResolvedKeys({
        ANTHROPIC_API_KEY: "anthropic-key",
        OPENAI_API_KEY: "openai-key",
      }),
    );

    const anthropicModels = registry.models.filter(
      (model) => model.provider === "anthropic",
    );
    const openaiModels = registry.models.filter(
      (model) => model.provider === "openai",
    );

    expect(anthropicModels.length).toBeGreaterThan(0);
    expect(openaiModels.length).toBeGreaterThan(0);
    expect(
      anthropicModels.every((model) => model.id.startsWith("anthropic/")),
    ).toBe(true);
    expect(openaiModels.every((model) => model.id.startsWith("openai/"))).toBe(
      true,
    );
  });

  it("supports status filtering for available models and exposes no unavailable cloud models", async () => {
    const registry = await createProviderRegistry(
      createConfig() as any,
      createResolvedKeys({ ANTHROPIC_API_KEY: "test-key" }),
    );

    const availableModels = registry.models.filter(
      (model) => model.status === "available",
    );
    const unavailableModels = registry.models.filter(
      (model) => model.status === "unavailable",
    );

    expect(availableModels.length).toBe(registry.models.length);
    expect(unavailableModels).toEqual([]);
  });
});
