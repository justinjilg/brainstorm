import { describe, it, expect } from 'vitest';
import { BrainstormRouter } from '../router.js';
import { CostTracker } from '../cost-tracker.js';
import type { ModelEntry, BudgetState } from '@brainstorm/shared';
import type { BrainstormConfig } from '@brainstorm/config';
import type { ProviderRegistry } from '@brainstorm/providers';

function makeConfig(overrides: any = {}): BrainstormConfig {
  return {
    general: { defaultStrategy: 'combined', confirmTools: true, defaultPermissionMode: 'confirm', theme: 'dark', maxSteps: 10, outputStyle: 'concise', ...overrides.general },
    compaction: { enabled: true, threshold: 0.8, keepRecent: 5 },
    shell: { defaultTimeout: 120000, maxOutputBytes: 50000, sandbox: 'none' },
    budget: { hardLimit: false, ...overrides.budget },
    providers: { gateway: { enabled: true, apiKeyEnv: '', baseUrl: '' }, ollama: { enabled: false, baseUrl: '', autoDiscover: false }, lmstudio: { enabled: false, baseUrl: '', autoDiscover: false }, llamacpp: { enabled: false, baseUrl: '', autoDiscover: false } },
    permissions: { allowlist: [], denylist: [] },
    routing: { rules: [] },
    models: [],
    agents: [],
    workflows: [],
    mcp: { servers: [] },
  } as any;
}

function makeModel(id: string, overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id, provider: 'test', name: id,
    capabilities: { toolCalling: true, streaming: true, vision: false, reasoning: false, contextWindow: 128000, qualityTier: 3, speedTier: 3, bestFor: [], ...overrides.capabilities },
    pricing: { inputPer1MTokens: 1, outputPer1MTokens: 3, ...overrides.pricing },
    limits: { contextWindow: 128000, maxOutputTokens: 4096 },
    status: 'available', isLocal: false, lastHealthCheck: Date.now(),
    ...overrides,
  } as ModelEntry;
}

function makeRegistry(models: ModelEntry[]): ProviderRegistry {
  return {
    models,
    hasBrainstormSaaS: false,
    getModel: (id) => models.find((m) => m.id === id),
    getProvider: (id) => id,
    refresh: async () => {},
  };
}

function makeCostTracker(): CostTracker {
  const mockDb = {
    prepare: () => ({
      run: () => {},
      get: () => ({ total: 0 }),
      all: () => [],
    }),
  };
  return new CostTracker(mockDb as any, { hardLimit: false });
}

describe('BrainstormRouter', () => {
  it('uses combined strategy by default', () => {
    const router = new BrainstormRouter(
      makeConfig(),
      makeRegistry([makeModel('test-model')]),
      makeCostTracker(),
    );
    expect(router.getActiveStrategy()).toBe('combined');
  });

  it('auto-selects capability strategy when eval data exists', () => {
    const modelWithScores = makeModel('scored', {
      capabilities: {
        capabilityScores: { toolSelection: 0.8, toolSequencing: 0.8, codeGeneration: 0.8, multiStepReasoning: 0.8, instructionFollowing: 0.8, contextUtilization: 0.8, selfCorrection: 0.8 },
      } as any,
    });
    const router = new BrainstormRouter(
      makeConfig(),
      makeRegistry([modelWithScores]),
      makeCostTracker(),
    );
    expect(router.getActiveStrategy()).toBe('capability');
  });

  it('does not auto-select capability if user explicitly set a strategy', () => {
    const modelWithScores = makeModel('scored', {
      capabilities: {
        capabilityScores: { toolSelection: 0.8, toolSequencing: 0.8, codeGeneration: 0.8, multiStepReasoning: 0.8, instructionFollowing: 0.8, contextUtilization: 0.8, selfCorrection: 0.8 },
      } as any,
    });
    const router = new BrainstormRouter(
      makeConfig({ general: { defaultStrategy: 'cost-first' } }),
      makeRegistry([modelWithScores]),
      makeCostTracker(),
    );
    // Should stay cost-first because user explicitly chose it
    expect(router.getActiveStrategy()).toBe('cost-first');
  });

  it('setStrategy changes active strategy', () => {
    const router = new BrainstormRouter(
      makeConfig(),
      makeRegistry([makeModel('m')]),
      makeCostTracker(),
    );
    router.setStrategy('quality-first');
    expect(router.getActiveStrategy()).toBe('quality-first');
  });

  it('recordFailure excludes model from next routing', () => {
    const router = new BrainstormRouter(
      makeConfig(),
      makeRegistry([makeModel('m1'), makeModel('m2')]),
      makeCostTracker(),
    );
    router.recordFailure('m1', 'test error');
    const task = router.classify('write some code');
    const decision = router.route(task);
    // m1 should be excluded (failed within 60s), so m2 is selected
    expect(decision.model.id).toBe('m2');
  });

  it('route falls back to any available model when strategy returns null', () => {
    const router = new BrainstormRouter(
      makeConfig(),
      makeRegistry([makeModel('fallback')]),
      makeCostTracker(),
    );
    const task = router.classify('hello');
    const decision = router.route(task);
    expect(decision.model.id).toBe('fallback');
  });

  it('route throws when no models available', () => {
    const router = new BrainstormRouter(
      makeConfig(),
      makeRegistry([]),
      makeCostTracker(),
    );
    const task = router.classify('test');
    expect(() => router.route(task)).toThrow('No models available');
  });
});
