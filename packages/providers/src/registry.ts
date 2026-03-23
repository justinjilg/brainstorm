import type { BrainstormConfig } from '@brainstorm/config';
import type { ModelEntry } from '@brainstorm/shared';
import { createOllamaProvider } from './local/ollama.js';
import { createLMStudioProvider, createLlamaCppProvider } from './local/openai-compat.js';
import { discoverLocalModels } from './local/discovery.js';
import { CLOUD_MODELS } from './cloud/models.js';
import { createBrainstormSaaSProvider, getBrainstormApiKey } from './cloud/brainstorm-saas.js';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export interface ProviderRegistry {
  models: ModelEntry[];
  getModel(id: string): ModelEntry | undefined;
  getProvider(modelId: string): any;
  hasBrainstormSaaS: boolean;
  refresh(): Promise<void>;
}

export async function createProviderRegistry(config: BrainstormConfig): Promise<ProviderRegistry> {
  const providers: Record<string, any> = {};

  // Local providers
  if (config.providers.ollama.enabled) {
    providers.ollama = createOllamaProvider(config.providers.ollama.baseUrl);
  }
  if (config.providers.lmstudio.enabled) {
    providers.lmstudio = createLMStudioProvider(config.providers.lmstudio.baseUrl);
  }
  if (config.providers.llamacpp.enabled) {
    providers.llamacpp = createLlamaCppProvider(config.providers.llamacpp.baseUrl);
  }

  // BrainstormRouter SaaS (primary cloud provider when configured)
  const brApiKey = getBrainstormApiKey();
  const hasBrainstormSaaS = !!brApiKey;
  if (brApiKey) {
    providers.brainstormrouter = createBrainstormSaaSProvider(brApiKey);
  }

  // Direct provider SDKs (fallback when no BR SaaS, or for direct API key usage)
  if (process.env.ANTHROPIC_API_KEY) {
    providers.anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  if (process.env.OPENAI_API_KEY) {
    providers.openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    providers.google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY });
  }

  // Only include cloud models for providers we have credentials for
  const availableCloudProviders = new Set<string>();
  if (brApiKey) availableCloudProviders.add('brainstormrouter'); // SaaS can route to any model
  if (process.env.ANTHROPIC_API_KEY) availableCloudProviders.add('anthropic');
  if (process.env.OPENAI_API_KEY) availableCloudProviders.add('openai');
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) availableCloudProviders.add('google');
  if (process.env.DEEPSEEK_API_KEY) {
    availableCloudProviders.add('deepseek');
    providers.deepseek = createOpenAICompatible({
      name: 'deepseek',
      baseURL: 'https://api.deepseek.com/v1',
      headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
    });
  }

  // If BR SaaS is available, all cloud models are reachable through it
  const reachableCloudModels = hasBrainstormSaaS
    ? CLOUD_MODELS
    : CLOUD_MODELS.filter((m) => availableCloudProviders.has(m.provider));

  let allModels = [...reachableCloudModels];

  // If BR SaaS is available, add "auto" model (intelligent SaaS routing)
  if (hasBrainstormSaaS) {
    allModels.unshift({
      id: 'brainstormrouter/auto',
      provider: 'brainstormrouter',
      name: 'BrainstormRouter Auto',
      capabilities: {
        toolCalling: true, streaming: true, vision: true, reasoning: true,
        contextWindow: 200000, qualityTier: 1, speedTier: 1,
        bestFor: ['code-generation', 'debugging', 'refactoring', 'analysis', 'multi-file-edit', 'explanation', 'conversation'],
      },
      pricing: { inputPer1MTokens: 0, outputPer1MTokens: 0 }, // SaaS handles pricing
      limits: { contextWindow: 200000, maxOutputTokens: 16384 },
      status: 'available', isLocal: false, lastHealthCheck: Date.now(),
    });
  }

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
    hasBrainstormSaaS,

    getModel(id: string) {
      return allModels.find((m) => m.id === id);
    },

    getProvider(modelId: string) {
      // BrainstormRouter SaaS: route through SaaS provider
      if (modelId.startsWith('brainstormrouter/') && providers.brainstormrouter) {
        const model = modelId.split('/')[1]; // "auto" or specific model
        return providers.brainstormrouter(model);
      }

      // Local models (ollama:xxx, lmstudio:xxx, llamacpp:xxx)
      const [providerName] = modelId.split(':');
      if (providerName && providers[providerName]) {
        const modelName = modelId.slice(providerName.length + 1);
        return providers[providerName](modelName);
      }

      // Cloud models ("provider/model" format) — resolve through direct SDK providers
      const [cloudProvider, ...modelParts] = modelId.split('/');
      const cloudModelName = modelParts.join('/');
      if (cloudProvider && providers[cloudProvider]) {
        return providers[cloudProvider](cloudModelName);
      }

      // Last resort: return the raw model ID string
      // (will fail unless AI Gateway or environment provides resolution)
      return modelId;
    },

    async refresh() {
      const { models: refreshedLocal } = await discoverLocalModels(config.providers);
      const cloudAndSaas = allModels.filter((m) => !m.isLocal);
      allModels = [...cloudAndSaas, ...refreshedLocal];
      registry.models = allModels;
    },
  };

  return registry;
}
