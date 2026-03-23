import type { ModelEntry } from '@brainstorm/shared';

// Built-in cloud model registry — pricing and capabilities for major models
// These are accessed through AI Gateway using "provider/model" format

export const CLOUD_MODELS: ModelEntry[] = [
  // ── Anthropic ──────────────────────────────────────────────────────
  {
    id: 'anthropic/claude-sonnet-4-5-20250620',
    provider: 'anthropic',
    name: 'Claude Sonnet 4.5',
    capabilities: {
      toolCalling: true, streaming: true, vision: true, reasoning: true,
      contextWindow: 200000, qualityTier: 1, speedTier: 2,
      bestFor: ['code-generation', 'debugging', 'refactoring', 'analysis', 'multi-file-edit'],
    },
    pricing: { inputPer1MTokens: 3, outputPer1MTokens: 15, cachedInputPer1MTokens: 0.3 },
    limits: { contextWindow: 200000, maxOutputTokens: 16384 },
    status: 'available', isLocal: false, lastHealthCheck: 0,
  },
  {
    id: 'anthropic/claude-haiku-4-5-20251001',
    provider: 'anthropic',
    name: 'Claude Haiku 4.5',
    capabilities: {
      toolCalling: true, streaming: true, vision: true, reasoning: false,
      contextWindow: 200000, qualityTier: 3, speedTier: 1,
      bestFor: ['simple-edit', 'explanation', 'conversation', 'search'],
    },
    pricing: { inputPer1MTokens: 0.8, outputPer1MTokens: 4, cachedInputPer1MTokens: 0.08 },
    limits: { contextWindow: 200000, maxOutputTokens: 8192 },
    status: 'available', isLocal: false, lastHealthCheck: 0,
  },
  // ── OpenAI ─────────────────────────────────────────────────────────
  {
    id: 'openai/gpt-4.1',
    provider: 'openai',
    name: 'GPT-4.1',
    capabilities: {
      toolCalling: true, streaming: true, vision: true, reasoning: true,
      contextWindow: 1047576, qualityTier: 1, speedTier: 2,
      bestFor: ['code-generation', 'debugging', 'refactoring', 'analysis', 'multi-file-edit'],
    },
    pricing: { inputPer1MTokens: 2, outputPer1MTokens: 8, cachedInputPer1MTokens: 0.5 },
    limits: { contextWindow: 1047576, maxOutputTokens: 32768 },
    status: 'available', isLocal: false, lastHealthCheck: 0,
  },
  {
    id: 'openai/gpt-4.1-mini',
    provider: 'openai',
    name: 'GPT-4.1 Mini',
    capabilities: {
      toolCalling: true, streaming: true, vision: true, reasoning: false,
      contextWindow: 1047576, qualityTier: 3, speedTier: 1,
      bestFor: ['simple-edit', 'explanation', 'conversation', 'search'],
    },
    pricing: { inputPer1MTokens: 0.4, outputPer1MTokens: 1.6, cachedInputPer1MTokens: 0.1 },
    limits: { contextWindow: 1047576, maxOutputTokens: 16384 },
    status: 'available', isLocal: false, lastHealthCheck: 0,
  },
  {
    id: 'openai/o3-mini',
    provider: 'openai',
    name: 'o3-mini',
    capabilities: {
      toolCalling: true, streaming: true, vision: false, reasoning: true,
      contextWindow: 200000, qualityTier: 2, speedTier: 2,
      bestFor: ['debugging', 'analysis', 'code-generation'],
    },
    pricing: { inputPer1MTokens: 1.1, outputPer1MTokens: 4.4, cachedInputPer1MTokens: 0.275 },
    limits: { contextWindow: 200000, maxOutputTokens: 100000 },
    status: 'available', isLocal: false, lastHealthCheck: 0,
  },
  // ── Google ─────────────────────────────────────────────────────────
  {
    id: 'google/gemini-2.5-flash',
    provider: 'google',
    name: 'Gemini 2.5 Flash',
    capabilities: {
      toolCalling: true, streaming: true, vision: true, reasoning: true,
      contextWindow: 1048576, qualityTier: 2, speedTier: 1,
      bestFor: ['code-generation', 'explanation', 'conversation', 'search'],
    },
    pricing: { inputPer1MTokens: 0.15, outputPer1MTokens: 0.6, cachedInputPer1MTokens: 0.0375 },
    limits: { contextWindow: 1048576, maxOutputTokens: 65536 },
    status: 'available', isLocal: false, lastHealthCheck: 0,
  },
  // ── DeepSeek ───────────────────────────────────────────────────────
  {
    id: 'deepseek/deepseek-chat',
    provider: 'deepseek',
    name: 'DeepSeek V3',
    capabilities: {
      toolCalling: true, streaming: true, vision: false, reasoning: false,
      contextWindow: 65536, qualityTier: 2, speedTier: 2,
      bestFor: ['code-generation', 'simple-edit', 'refactoring'],
    },
    pricing: { inputPer1MTokens: 0.27, outputPer1MTokens: 1.1, cachedInputPer1MTokens: 0.07 },
    limits: { contextWindow: 65536, maxOutputTokens: 8192 },
    status: 'available', isLocal: false, lastHealthCheck: 0,
  },
];
