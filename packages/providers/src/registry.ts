import type { BrainstormConfig } from '@brainstorm/config';
import type { ModelEntry } from '@brainstorm/shared';
import { createOllamaProvider } from './local/ollama.js';
import { createLMStudioProvider, createLlamaCppProvider } from './local/openai-compat.js';
import { discoverLocalModels } from './local/discovery.js';
import { CLOUD_MODELS } from './cloud/models.js';

export interface ProviderRegistry {
  models: ModelEntry[];
  getModel(id: string): ModelEntry | undefined;
  getProvider(modelId: string): any; // AI SDK provider instance
  refresh(): Promise<void>;
}

export async function createProviderRegistry(config: BrainstormConfig): Promise<ProviderRegistry> {
  // Initialize AI SDK providers
  const providers: Record<string, any> = {};

  if (config.providers.ollama.enabled) {
    providers.ollama = createOllamaProvider(config.providers.ollama.baseUrl);
  }
  if (config.providers.lmstudio.enabled) {
    providers.lmstudio = createLMStudioProvider(config.providers.lmstudio.baseUrl);
  }
  if (config.providers.llamacpp.enabled) {
    providers.llamacpp = createLlamaCppProvider(config.providers.llamacpp.baseUrl);
  }

  // Start with cloud models
  let allModels = [...CLOUD_MODELS];

  // Discover local models
  const { models: localModels } = await discoverLocalModels(config.providers);
  allModels.push(...localModels);

  // Apply model overrides from config
  for (const override of config.models) {
    const existing = allModels.find((m) => m.id === override.id);
    if (existing) {
      if (override.qualityTier) existing.capabilities.qualityTier = override.qualityTier as any;
      if (override.speedTier) existing.capabilities.speedTier = override.speedTier as any;
      if (override.bestFor) existing.capabilities.bestFor = override.bestFor as any;
    }
  }

  const registry: ProviderRegistry = {
    models: allModels,

    getModel(id: string) {
      return allModels.find((m) => m.id === id);
    },

    getProvider(modelId: string) {
      const [providerName] = modelId.split(':');
      if (providerName && providers[providerName]) {
        // For local models, extract model name after "provider:"
        const modelName = modelId.slice(providerName.length + 1);
        return providers[providerName](modelName);
      }
      // For cloud models ("provider/model" format), return the ID directly
      // AI SDK resolves these through AI Gateway or direct provider
      return modelId;
    },

    async refresh() {
      const { models: refreshedLocal } = await discoverLocalModels(config.providers);
      // Replace local models, keep cloud
      allModels = [...CLOUD_MODELS, ...refreshedLocal];
      registry.models = allModels;
    },
  };

  return registry;
}
