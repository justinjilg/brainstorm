import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ProviderConfig } from '@brainstorm/config';
import type { ModelEntry } from '@brainstorm/shared';
import { createLogger } from '@brainstorm/shared';
import { discoverOllamaModels } from './ollama.js';
import { discoverOpenAICompatModels } from './openai-compat.js';

const log = createLogger('discovery');

export interface DiscoveryResult {
  models: ModelEntry[];
  errors: Array<{ provider: string; error: string }>;
}

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_DIR = join(homedir(), '.brainstorm');
const CACHE_FILE = join(CACHE_DIR, '.providers.cache.json');

interface DiscoveryCache {
  timestamp: number;
  result: DiscoveryResult;
}

function readCache(): DiscoveryResult | null {
  if (process.env.BRAINSTORM_SKIP_DISCOVERY_CACHE) return null;
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const raw: DiscoveryCache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
    if (Date.now() - raw.timestamp > CACHE_TTL_MS) return null;
    return raw.result;
  } catch (e) {
    log.warn({ err: e }, 'Failed to read provider discovery cache');
    return null;
  }
}

function writeCache(result: DiscoveryResult): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const cache: DiscoveryCache = { timestamp: Date.now(), result };
    writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf-8');
  } catch (e) {
    log.warn({ err: e }, 'Failed to write provider discovery cache');
  }
}

export async function discoverLocalModels(config: ProviderConfig): Promise<DiscoveryResult> {
  const cached = readCache();
  if (cached) return cached;
  // Build probe tasks — one per enabled provider
  const probes: Array<{ provider: string; promise: Promise<ModelEntry[]> }> = [];

  if (config.ollama.enabled && config.ollama.autoDiscover) {
    probes.push({ provider: 'ollama', promise: discoverOllamaModels(config.ollama.baseUrl) });
  }
  if (config.lmstudio.enabled && config.lmstudio.autoDiscover) {
    probes.push({ provider: 'lmstudio', promise: discoverOpenAICompatModels('lmstudio', config.lmstudio.baseUrl) });
  }
  if (config.llamacpp.enabled && config.llamacpp.autoDiscover) {
    probes.push({ provider: 'llamacpp', promise: discoverOpenAICompatModels('llamacpp', config.llamacpp.baseUrl) });
  }

  // Run all probes in parallel — one failure doesn't block others
  const settled = await Promise.allSettled(probes.map((p) => p.promise));

  const models: ModelEntry[] = [];
  const errors: Array<{ provider: string; error: string }> = [];

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    if (outcome.status === 'fulfilled') {
      models.push(...outcome.value);
    } else {
      errors.push({ provider: probes[i].provider, error: String(outcome.reason) });
    }
  }

  const result = { models, errors };
  if (models.length > 0) writeCache(result);
  return result;
}
