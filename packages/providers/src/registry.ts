import type { BrainstormConfig } from "@brainst0rm/config";
import type { ModelEntry, CapabilityScores } from "@brainst0rm/shared";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createOllamaProvider } from "./local/ollama.js";
import {
  createLMStudioProvider,
  createLlamaCppProvider,
} from "./local/openai-compat.js";
import { discoverLocalModels } from "./local/discovery.js";
import { CLOUD_MODELS } from "./cloud/models.js";
import { createBrainstormSaaSProvider } from "./cloud/brainstorm-saas.js";
import type { BrEnvelopeListener } from "./cloud/br-envelope.js";
import { fetchBrCatalog, mergeBrCatalog } from "./cloud/br-catalog.js";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export interface ProviderRegistry {
  models: ModelEntry[];
  getModel(id: string): ModelEntry | undefined;
  getProvider(modelId: string): any;
  hasBrainstormSaaS: boolean;
  refresh(): Promise<void>;
}

/**
 * Optional pre-resolved API keys from the vault/1Password/env chain.
 * When provided, these take priority over process.env for provider setup.
 */
export interface ResolvedKeys {
  get(name: string): string | null;
}

/**
 * Optional callbacks/wires applied during registry construction.
 * Kept as an open-shape object so we can grow it without re-threading
 * 9 call sites in the CLI every time a new hook is added.
 */
export interface ProviderRegistryOptions {
  /** Fired per BR response with the parsed envelope. Wired to the
   *  routing_audit writer by the CLI bootstrap (P2b). The fetch path
   *  in brainstorm-saas.ts invokes this fire-and-forget; rejections are
   *  caught at the call site. */
  onEnvelope?: BrEnvelopeListener;
}

export async function createProviderRegistry(
  config: BrainstormConfig,
  resolvedKeys?: ResolvedKeys,
  options: ProviderRegistryOptions = {},
): Promise<ProviderRegistry> {
  /** Resolve a key: check resolvedKeys first, then fall back to process.env. */
  const getKey = (name: string): string | null =>
    resolvedKeys?.get(name) ?? process.env[name] ?? null;

  const providers: Record<string, any> = {};

  // Local providers
  if (config.providers.ollama.enabled) {
    providers.ollama = createOllamaProvider(config.providers.ollama.baseUrl);
  }
  if (config.providers.lmstudio.enabled) {
    providers.lmstudio = createLMStudioProvider(
      config.providers.lmstudio.baseUrl,
    );
  }
  if (config.providers.llamacpp.enabled) {
    providers.llamacpp = createLlamaCppProvider(
      config.providers.llamacpp.baseUrl,
    );
  }

  // BrainstormRouter SaaS — only enabled with an explicit API key.
  // The embedded community key is NOT used implicitly to prevent sending
  // prompts/code to a remote service without explicit opt-in.
  //
  // (Prior code had a second branch that tried
  // `getBrainstormApiKey()` when `explicitBrKey` was null but
  // process.env.BRAINSTORM_API_KEY was set — unreachable, because
  // getKey() ALREADY falls through to process.env, so
  // explicitBrKey is never null when env is set. Removed to make
  // the "explicit opt-in" invariant non-fragile: a future
  // refactor can't accidentally revive the implicit community-key
  // path by changing getKey's fallthrough order.)
  const brApiKey = getKey("BRAINSTORM_API_KEY");
  const hasBrainstormSaaS = !!brApiKey;
  if (brApiKey) {
    providers.brainstormrouter = createBrainstormSaaSProvider(brApiKey, {
      onEnvelope: options.onEnvelope,
    });
  }

  // Direct provider SDKs (fallback when no BR SaaS, or for direct API key usage)
  const anthropicKey = getKey("ANTHROPIC_API_KEY");
  if (anthropicKey) {
    providers.anthropic = createAnthropic({ apiKey: anthropicKey });
  }
  const openaiKey = getKey("OPENAI_API_KEY");
  if (openaiKey) {
    providers.openai = createOpenAI({ apiKey: openaiKey });
  }
  // Accept either GOOGLE_GENERATIVE_AI_API_KEY (AI SDK convention) or
  // GEMINI_API_KEY (Google's own convention, commonly already set in shells).
  const googleKey =
    getKey("GOOGLE_GENERATIVE_AI_API_KEY") ?? getKey("GEMINI_API_KEY");
  if (googleKey) {
    providers.google = createGoogleGenerativeAI({ apiKey: googleKey });
  }

  // Only include cloud models for providers we have credentials for
  const availableCloudProviders = new Set<string>();
  if (brApiKey) availableCloudProviders.add("brainstormrouter"); // SaaS can route to any model
  if (anthropicKey) availableCloudProviders.add("anthropic");
  if (openaiKey) availableCloudProviders.add("openai");
  if (googleKey) availableCloudProviders.add("google");
  const deepseekKey = getKey("DEEPSEEK_API_KEY");
  if (deepseekKey) {
    availableCloudProviders.add("deepseek");
    providers.deepseek = createOpenAICompatible({
      name: "deepseek",
      baseURL: "https://api.deepseek.com/v1",
      headers: { Authorization: `Bearer ${deepseekKey}` },
      includeUsage: true,
    });
  }
  const moonshotKey = getKey("MOONSHOT_API_KEY");
  if (moonshotKey) {
    availableCloudProviders.add("moonshot");
    providers.moonshot = createOpenAICompatible({
      name: "moonshot",
      baseURL: "https://api.moonshot.ai/v1",
      headers: { Authorization: `Bearer ${moonshotKey}` },
      includeUsage: true,
    });
  }

  // Include all cloud models reachable via SaaS or direct keys.
  // Models with direct provider keys are marked preferred for routing.
  const hasDirectKeys =
    availableCloudProviders.size > (hasBrainstormSaaS ? 1 : 0);

  // Source-of-truth precedence for the cloud model list:
  //   1. BR live `/v1/models` (when we have a BR key) — fresh, includes
  //      models the local CLOUD_MODELS constant doesn't know about yet.
  //   2. Disk cache from the last successful BR fetch — offline fallback.
  //   3. Static CLOUD_MODELS — direct-key-only or first-run-offline.
  // Local capability scores / qualityTier / bestFor are overlaid onto
  // BR entries by id; BR doesn't track those heuristics.
  let reachableCloudModels: ModelEntry[];
  if (hasBrainstormSaaS && brApiKey) {
    const brEntries = await fetchBrCatalog(brApiKey);
    if (brEntries) {
      reachableCloudModels = mergeBrCatalog(brEntries, CLOUD_MODELS);
    } else {
      const cached = loadProviderCache();
      reachableCloudModels = cached?.models ?? CLOUD_MODELS;
    }
  } else {
    reachableCloudModels = CLOUD_MODELS.filter((m) =>
      availableCloudProviders.has(m.provider),
    );
  }

  let allModels = [...reachableCloudModels];

  // If BR SaaS is available, add "auto" model (intelligent SaaS routing)
  if (hasBrainstormSaaS) {
    allModels.unshift({
      id: "brainstormrouter/auto",
      provider: "brainstormrouter",
      name: "BrainstormRouter Auto",
      capabilities: {
        toolCalling: true,
        streaming: true,
        vision: true,
        reasoning: true,
        contextWindow: 200000,
        qualityTier: 1,
        speedTier: 1,
        bestFor: [
          "code-generation",
          "debugging",
          "refactoring",
          "analysis",
          "multi-file-edit",
          "explanation",
          "conversation",
        ],
      },
      pricing: { inputPer1MTokens: 0, outputPer1MTokens: 0 }, // SaaS handles pricing
      limits: { contextWindow: 200000, maxOutputTokens: 16384 },
      status: "available",
      isLocal: false,
      lastHealthCheck: Date.now(),
    });
  }

  // Discover local models
  const { models: localModels } = await discoverLocalModels(config.providers);
  allModels.push(...localModels);

  // Apply model overrides from config
  for (const override of config.models) {
    const existing = allModels.find((m) => m.id === override.id);
    if (existing) {
      if (override.qualityTier)
        existing.capabilities.qualityTier = override.qualityTier as any;
      if (override.speedTier)
        existing.capabilities.speedTier = override.speedTier as any;
      if (override.bestFor)
        existing.capabilities.bestFor = override.bestFor as any;
    }
  }

  // Overlay eval-derived capability scores (from `brainstorm eval`) and mark
  // them as measured. Models without eval data keep their static assumed
  // scores but are flagged as unmeasured — the capability strategy prefers
  // measured scores over assumed ones to avoid rewarding guesses.
  const evalScores = loadEvalCapabilityScores();
  for (const [modelId, entry] of Object.entries(evalScores)) {
    const model = allModels.find((m) => m.id === modelId);
    if (model) {
      model.capabilities.capabilityScores = entry.scores;
      (model.capabilities as any).scoresAreMeasured = true;
    }
  }

  // Persist model list to cache for faster subsequent startups
  saveProviderCache(allModels);

  const registry: ProviderRegistry = {
    models: allModels,
    hasBrainstormSaaS,

    getModel(id: string) {
      return allModels.find((m) => m.id === id);
    },

    getProvider(modelId: string) {
      // BrainstormRouter SaaS: route through SaaS provider
      if (
        modelId.startsWith("brainstormrouter/") &&
        providers.brainstormrouter
      ) {
        const model = modelId.split("/")[1]; // "auto" or specific model
        return providers.brainstormrouter(model);
      }

      // Local models (ollama:xxx, lmstudio:xxx, llamacpp:xxx)
      const [providerName] = modelId.split(":");
      if (providerName && providers[providerName]) {
        const modelName = modelId.slice(providerName.length + 1);
        return providers[providerName](modelName);
      }

      // Cloud models ("provider/model" format) — resolve through direct SDK providers
      const [cloudProvider, ...modelParts] = modelId.split("/");
      const cloudModelName = modelParts.join("/");
      if (cloudProvider && providers[cloudProvider]) {
        return providers[cloudProvider](cloudModelName);
      }

      // No direct provider SDK available — route through BrainstormRouter if available.
      // This handles the common case where the router picks "openai/gpt-4.1" but the
      // user only has a BR key (no OPENAI_API_KEY). BR can route to any model.
      if (providers.brainstormrouter) {
        return providers.brainstormrouter(modelId);
      }

      // Last resort: return the raw model ID string
      return modelId;
    },

    async refresh() {
      const { models: refreshedLocal } = await discoverLocalModels(
        config.providers,
      );
      const cloudAndSaas = allModels.filter((m) => !m.isLocal);
      allModels = [...cloudAndSaas, ...refreshedLocal];
      // Re-apply eval capability scores (may have been updated by brainstorm eval)
      const freshScores = loadEvalCapabilityScores();
      for (const [modelId, entry] of Object.entries(freshScores)) {
        const model = allModels.find((m) => m.id === modelId);
        if (model) {
          model.capabilities.capabilityScores = entry.scores;
        }
      }
      registry.models = allModels;
    },
  };

  return registry;
}

/**
 * Load eval-derived capability scores from ~/.brainstorm/eval/capability-scores.json.
 * These are written by `brainstorm eval` via @brainst0rm/eval's exportCapabilityScores().
 * Reading directly avoids a circular dependency (eval → providers → eval).
 */
const CACHE_PATH = join(homedir(), ".brainstorm", ".providers.cache.json");
// Cache TTL is intentionally long — its purpose is offline fallback when
// BR /v1/models can't be reached, not freshness gating. A live BR fetch
// at registry init takes precedence whenever it succeeds.
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CACHE_VERSION = 2; // v1 stored only `modelIds`; v2 stores full ModelEntry[]

interface ProviderCacheV2 {
  version: number;
  timestamp: number;
  models: ModelEntry[];
}

function loadProviderCache(): ProviderCacheV2 | null {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    const raw = readFileSync(CACHE_PATH, "utf-8");
    // Guard against corrupt/oversized cache files (max 1MB)
    if (raw.length > 1_000_000) return null;
    const data = JSON.parse(raw);
    if (
      data?.version !== CACHE_VERSION ||
      typeof data?.timestamp !== "number" ||
      !Array.isArray(data?.models)
    ) {
      return null;
    }
    if (Date.now() - data.timestamp > CACHE_TTL_MS) return null;
    return data as ProviderCacheV2;
  } catch {
    return null;
  }
}

function saveProviderCache(models: ModelEntry[]): void {
  try {
    const dir = join(homedir(), ".brainstorm");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const cache: ProviderCacheV2 = {
      version: CACHE_VERSION,
      timestamp: Date.now(),
      models,
    };
    writeFileSync(CACHE_PATH, JSON.stringify(cache), "utf-8");
  } catch {
    // Non-fatal — caching is best-effort
  }
}

function loadEvalCapabilityScores(): Record<
  string,
  { scores: CapabilityScores; evaluatedAt: number }
> {
  const scoresPath = join(
    homedir(),
    ".brainstorm",
    "eval",
    "capability-scores.json",
  );
  if (!existsSync(scoresPath)) return {};
  try {
    return JSON.parse(readFileSync(scoresPath, "utf-8"));
  } catch {
    return {};
  }
}
