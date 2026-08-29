import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { ProviderConfig } from "@brainst0rm/config";
import type { ModelEntry } from "@brainst0rm/shared";
import { createLogger } from "@brainst0rm/shared";
import { discoverOllamaModels } from "./ollama.js";
import {
  discoverOpenAICompatModels,
  resolveLocalAuth,
} from "./openai-compat.js";

// Direct callers default to environment resolution. Registry callers pass the
// same vault-aware resolver used to construct providers so discovery and chat
// cannot disagree about authentication.
const envKey = (name: string): string | null => process.env[name] ?? null;

const log = createLogger("discovery");

export interface DiscoveryResult {
  models: ModelEntry[];
  errors: Array<{ provider: string; error: string }>;
}

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
function cacheDir(): string {
  return process.env.BRAINSTORM_HOME ?? join(homedir(), ".brainstorm");
}

function cacheFile(): string {
  // Keep local-discovery results separate from registry.ts's model-id cache.
  // The two caches previously overwrote the same file with incompatible
  // shapes, making discovery caching both ineffective and configuration-blind.
  return join(cacheDir(), ".local-providers.cache.json");
}

interface DiscoveryCache {
  timestamp: number;
  configKey: string;
  result: DiscoveryResult;
}

function readCache(configKey: string): DiscoveryResult | null {
  if (process.env.BRAINSTORM_SKIP_DISCOVERY_CACHE) return null;
  try {
    const path = cacheFile();
    if (!existsSync(path)) return null;
    const raw: DiscoveryCache = JSON.parse(readFileSync(path, "utf-8"));
    if (Date.now() - raw.timestamp > CACHE_TTL_MS) return null;
    if (raw.configKey !== configKey) return null;
    return raw.result;
  } catch (e) {
    log.warn({ err: e }, "Failed to read provider discovery cache");
    return null;
  }
}

function writeCache(configKey: string, result: DiscoveryResult): void {
  try {
    const dir = cacheDir();
    mkdirSync(dir, { recursive: true });
    const cache: DiscoveryCache = {
      timestamp: Date.now(),
      configKey,
      result,
    };
    writeFileSync(cacheFile(), JSON.stringify(cache), {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch (e) {
    log.warn({ err: e }, "Failed to write provider discovery cache");
  }
}

export async function discoverLocalModels(
  config: ProviderConfig,
  resolveKey: (name: string) => string | null = envKey,
): Promise<DiscoveryResult> {
  const resolvedAuth = {
    ollama: resolveLocalAuth(config.ollama, resolveKey),
    lmstudio: resolveLocalAuth(config.lmstudio, resolveKey),
    llamacpp: resolveLocalAuth(config.llamacpp, resolveKey),
  };
  // Cache keys include endpoint/provider state plus one-way digests of resolved
  // auth. Secrets never land in the cache, while token/header rotations cannot
  // reuse discovery results from a different security context.
  const configKey = createHash("sha256")
    .update(
      JSON.stringify({
        providers: config,
        auth: Object.fromEntries(
          Object.entries(resolvedAuth).map(([name, auth]) => [
            name,
            auth
              ? createHash("sha256").update(JSON.stringify(auth)).digest("hex")
              : null,
          ]),
        ),
      }),
    )
    .digest("hex");
  const cached = readCache(configKey);
  if (cached) return cached;
  // Build probe tasks — one per enabled provider
  const probes: Array<{ provider: string; promise: Promise<ModelEntry[]> }> =
    [];
  const errors: Array<{ provider: string; error: string }> = [];

  const hasRequiredAuth = (
    provider: string,
    cfg: { apiKeyEnv?: string },
    auth: { apiKey?: string } | undefined,
  ): boolean => {
    if (!cfg.apiKeyEnv || auth?.apiKey) return true;
    errors.push({
      provider,
      error: `Configured key ${cfg.apiKeyEnv} could not be resolved`,
    });
    return false;
  };

  if (
    config.ollama.enabled &&
    config.ollama.autoDiscover &&
    hasRequiredAuth("ollama", config.ollama, resolvedAuth.ollama)
  ) {
    probes.push({
      provider: "ollama",
      promise: discoverOllamaModels(config.ollama.baseUrl, resolvedAuth.ollama),
    });
  }
  if (
    config.lmstudio.enabled &&
    config.lmstudio.autoDiscover &&
    hasRequiredAuth("lmstudio", config.lmstudio, resolvedAuth.lmstudio)
  ) {
    probes.push({
      provider: "lmstudio",
      promise: discoverOpenAICompatModels(
        "lmstudio",
        config.lmstudio.baseUrl,
        resolvedAuth.lmstudio,
      ),
    });
  }
  if (
    config.llamacpp.enabled &&
    config.llamacpp.autoDiscover &&
    hasRequiredAuth("llamacpp", config.llamacpp, resolvedAuth.llamacpp)
  ) {
    probes.push({
      provider: "llamacpp",
      promise: discoverOpenAICompatModels(
        "llamacpp",
        config.llamacpp.baseUrl,
        resolvedAuth.llamacpp,
      ),
    });
  }

  // Run all probes in parallel — one failure doesn't block others
  const settled = await Promise.allSettled(probes.map((p) => p.promise));

  const models: ModelEntry[] = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    if (outcome.status === "fulfilled") {
      models.push(...outcome.value);
    } else {
      errors.push({
        provider: probes[i].provider,
        error: String(outcome.reason),
      });
    }
  }

  const result = { models, errors };
  if (models.length > 0) writeCache(configKey, result);
  return result;
}
