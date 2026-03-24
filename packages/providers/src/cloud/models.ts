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
      capabilityScores: { toolSelection: 0.92, toolSequencing: 0.88, codeGeneration: 0.93, multiStepReasoning: 0.90, instructionFollowing: 0.91, contextUtilization: 0.89, selfCorrection: 0.85 },
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
      capabilityScores: { toolSelection: 0.80, toolSequencing: 0.72, codeGeneration: 0.78, multiStepReasoning: 0.65, instructionFollowing: 0.82, contextUtilization: 0.75, selfCorrection: 0.60 },
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
      capabilityScores: { toolSelection: 0.90, toolSequencing: 0.85, codeGeneration: 0.91, multiStepReasoning: 0.88, instructionFollowing: 0.87, contextUtilization: 0.92, selfCorrection: 0.82 },
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
      capabilityScores: { toolSelection: 0.78, toolSequencing: 0.70, codeGeneration: 0.75, multiStepReasoning: 0.60, instructionFollowing: 0.80, contextUtilization: 0.85, selfCorrection: 0.55 },
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
      capabilityScores: { toolSelection: 0.82, toolSequencing: 0.78, codeGeneration: 0.86, multiStepReasoning: 0.90, instructionFollowing: 0.84, contextUtilization: 0.80, selfCorrection: 0.75 },
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
      capabilityScores: { toolSelection: 0.82, toolSequencing: 0.75, codeGeneration: 0.80, multiStepReasoning: 0.78, instructionFollowing: 0.77, contextUtilization: 0.93, selfCorrection: 0.68 },
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
      capabilityScores: { toolSelection: 0.75, toolSequencing: 0.68, codeGeneration: 0.85, multiStepReasoning: 0.72, instructionFollowing: 0.70, contextUtilization: 0.65, selfCorrection: 0.58 },
    },
    pricing: { inputPer1MTokens: 0.27, outputPer1MTokens: 1.1, cachedInputPer1MTokens: 0.07 },
    limits: { contextWindow: 65536, maxOutputTokens: 8192 },
    status: 'available', isLocal: false, lastHealthCheck: 0,
  },
];
