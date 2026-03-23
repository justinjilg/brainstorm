import type { ProviderConfig } from '@brainstorm/config';
import type { ModelEntry } from '@brainstorm/shared';
import { discoverOllamaModels } from './ollama.js';
import { discoverOpenAICompatModels } from './openai-compat.js';

export interface DiscoveryResult {
  models: ModelEntry[];
  errors: Array<{ provider: string; error: string }>;
}

export async function discoverLocalModels(config: ProviderConfig): Promise<DiscoveryResult> {
  const models: ModelEntry[] = [];
  const errors: Array<{ provider: string; error: string }> = [];

  const tasks: Promise<void>[] = [];

  if (config.ollama.enabled && config.ollama.autoDiscover) {
    tasks.push(
      discoverOllamaModels(config.ollama.baseUrl)
        .then((m) => { models.push(...m); })
        .catch((e) => { errors.push({ provider: 'ollama', error: String(e) }); }),
    );
  }

  if (config.lmstudio.enabled && config.lmstudio.autoDiscover) {
    tasks.push(
      discoverOpenAICompatModels('lmstudio', config.lmstudio.baseUrl)
        .then((m) => { models.push(...m); })
        .catch((e) => { errors.push({ provider: 'lmstudio', error: String(e) }); }),
    );
  }

  if (config.llamacpp.enabled && config.llamacpp.autoDiscover) {
    tasks.push(
      discoverOpenAICompatModels('llamacpp', config.llamacpp.baseUrl)
        .then((m) => { models.push(...m); })
        .catch((e) => { errors.push({ provider: 'llamacpp', error: String(e) }); }),
    );
  }

  await Promise.all(tasks);
  return { models, errors };
}
