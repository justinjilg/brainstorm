import { describe, it, expect } from 'vitest';
import { serializeRoutingMetadata } from '../telemetry.js';
import type { TaskProfile, RoutingDecision } from '../types.js';

describe('serializeRoutingMetadata', () => {
  const createMinimalTask = (): TaskProfile => ({
    type: 'code',
    complexity: 'medium',
    requiresToolUse: true,
    requiresReasoning: false,
  });

  const createMinimalDecision = (): RoutingDecision => ({
    model: { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
    strategy: 'performance',
    estimatedCost: 0.123456789,
    reason: 'Selected for performance',
  });

  it('returns valid JSON string', () => {
    const task = createMinimalTask();
    const decision = createMinimalDecision();

    const result = serializeRoutingMetadata(task, decision);

    expect(result).toBeDefined();
    expect(() => JSON.parse(result!)).not.toThrow();
  });

  it('includes all required fields in serialized output', () => {
    const task = createMinimalTask();
    const decision = createMinimalDecision();

    const result = serializeRoutingMetadata(task, decision);
    const parsed = JSON.parse(result!);

    expect(parsed).toMatchObject({
      v: 1,
      tt: 'code',
      cx: 'medium',
      tu: true,
      rr: false,
      st: 'performance',
      mid: 'claude-3-5-sonnet-20241022',
      ec: 0.123457, // rounded to 6 decimal places
      src: 'cli',
    });
  });

  it('strips non-ASCII characters from reason field', () => {
    const task = createMinimalTask();
    const decision: RoutingDecision = {
      model: { id: 'model-1', name: 'Model 1' },
      strategy: 'balanced',
      estimatedCost: 0.01,
      reason: 'Selected for 性能 and émojis 🚀',
    };

    const result = serializeRoutingMetadata(task, decision);
    const parsed = JSON.parse(result!);

    // Non-ASCII characters should be removed
    expect(parsed.rs).toBe('Selected for  and mojis ');
    expect(parsed.rs).not.toContain('性能');
    expect(parsed.rs).not.toContain('🚀');
    expect(parsed.rs).not.toContain('é');
  });

  it('ensures only ASCII characters in output', () => {
    const task: TaskProfile = {
      type: 'code',
      complexity: 'high',
      requiresToolUse: true,
      requiresReasoning: true,
      language: 'TypeScript',
      domain: 'web',
    };
    const decision: RoutingDecision = {
      model: { id: 'model-1', name: 'Model 1' },
      strategy: 'cost',
      estimatedCost: 0.5,
      reason: 'Good choice 👍 for français',
    };

    const result = serializeRoutingMetadata(task, decision);

    // Verify all characters are in ASCII range (0x20-0x7E)
    expect(result).toBeDefined();
    const allAscii = result!.split('').every((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x20 && code <= 0x7e;
    });
    expect(allAscii).toBe(true);
  });

  it('respects max 10 key limit', () => {
    const task: TaskProfile = {
      type: 'code',
      complexity: 'high',
      requiresToolUse: true,
      requiresReasoning: true,
      language: 'TypeScript',
      domain: 'backend',
    };
    const decision: RoutingDecision = {
      model: { id: 'model-1', name: 'Model 1' },
      strategy: 'balanced',
      estimatedCost: 0.01,
      reason: 'This is a good reason',
    };

    const result = serializeRoutingMetadata(task, decision);
    const parsed = JSON.parse(result!);
    const keyCount = Object.keys(parsed).length;

    expect(keyCount).toBeLessThanOrEqual(10);
  });

  it('prioritizes language over domain and reason for optional fields', () => {
    const task: TaskProfile = {
      type: 'code',
      complexity: 'medium',
      requiresToolUse: false,
      requiresReasoning: true,
      language: 'Python',
      domain: 'data-science',
    };
    const decision: RoutingDecision = {
      model: { id: 'model-1', name: 'Model 1' },
      strategy: 'performance',
      estimatedCost: 0.02,
      reason: 'Best for this task',
    };

    const result = serializeRoutingMetadata(task, decision);
    const parsed = JSON.parse(result!);

    // Language should be included as the first optional field
    expect(parsed.lang).toBe('Python');
    // Domain and reason should not be included (respecting 10 key limit)
    expect(parsed.dom).toBeUndefined();
    expect(parsed.rs).toBeUndefined();
  });

  it('includes domain when language is not present', () => {
    const task: TaskProfile = {
      type: 'analysis',
      complexity: 'low',
      requiresToolUse: false,
      requiresReasoning: false,
      domain: 'finance',
    };
    const decision: RoutingDecision = {
      model: { id: 'model-2', name: 'Model 2' },
      strategy: 'cost',
      estimatedCost: 0.005,
      reason: 'Cheapest option',
    };

    const result = serializeRoutingMetadata(task, decision);
    const parsed = JSON.parse(result!);

    expect(parsed.lang).toBeUndefined();
    expect(parsed.dom).toBe('finance');
    expect(parsed.rs).toBeUndefined();
  });

  it('includes reason when language and domain are not present', () => {
    const task: TaskProfile = {
      type: 'general',
      complexity: 'medium',
      requiresToolUse: true,
      requiresReasoning: true,
    };
    const decision: RoutingDecision = {
      model: { id: 'model-3', name: 'Model 3' },
      strategy: 'balanced',
      estimatedCost: 0.015,
      reason: 'Balanced approach for general tasks',
    };

    const result = serializeRoutingMetadata(task, decision);
    const parsed = JSON.parse(result!);

    expect(parsed.lang).toBeUndefined();
    expect(parsed.dom).toBeUndefined();
    expect(parsed.rs).toBe('Balanced approach for general tasks');
  });

  it('truncates reason to 64 characters', () => {
    const task = createMinimalTask();
    const longReason = 'A'.repeat(100);
    const decision: RoutingDecision = {
      model: { id: 'model-1', name: 'Model 1' },
      strategy: 'performance',
      estimatedCost: 0.01,
      reason: longReason,
    };

    const result = serializeRoutingMetadata(task, decision);
    const parsed = JSON.parse(result!);

    expect(parsed.rs).toBeDefined();
    expect(parsed.rs?.length).toBe(64);
    expect(parsed.rs).toBe('A'.repeat(64));
  });

  it('returns undefined on invalid task input', () => {
    const invalidTask = null as any;
    const decision = createMinimalDecision();

    const result = serializeRoutingMetadata(invalidTask, decision);

    expect(result).toBeUndefined();
  });

  it('returns undefined on invalid decision input', () => {
    const task = createMinimalTask();
    const invalidDecision = null as any;

    const result = serializeRoutingMetadata(task, invalidDecision);

    expect(result).toBeUndefined();
  });

  it('returns undefined when model is missing', () => {
    const task = createMinimalTask();
    const decision = {
      strategy: 'performance',
      estimatedCost: 0.01,
    } as any;

    const result = serializeRoutingMetadata(task, decision);

    expect(result).toBeUndefined();
  });

  it('rounds estimated cost to 6 decimal places', () => {
    const task = createMinimalTask();
    const decision: RoutingDecision = {
      model: { id: 'model-1', name: 'Model 1' },
      strategy: 'cost',
      estimatedCost: 0.123456789123,
      reason: 'Test cost rounding',
    };

    const result = serializeRoutingMetadata(task, decision);
    const parsed = JSON.parse(result!);

    expect(parsed.ec).toBe(0.123457);
  });

  it('drops optional fields when exceeding 512 byte limit', () => {
    // Create a scenario where adding optional fields pushes us over 512 bytes
    const task: TaskProfile = {
      type: 'A'.repeat(200),
      complexity: 'B'.repeat(200),
      requiresToolUse: true,
      requiresReasoning: true,
      language: 'TypeScript',
      domain: 'backend',
    };
    const decision: RoutingDecision = {
      model: { id: 'C'.repeat(200), name: 'Model' },
      strategy: 'performance',
      estimatedCost: 0.01,
      reason: 'Some reason for this choice',
    };

    const result = serializeRoutingMetadata(task, decision);

    expect(result).toBeDefined();
    
    const parsed = JSON.parse(result!);
    // Optional fields should be dropped when size exceeded
    expect(parsed.lang).toBeUndefined();
    expect(parsed.dom).toBeUndefined();
    expect(parsed.rs).toBeUndefined();
    // Required fields should still be present
    expect(parsed.v).toBe(1);
    expect(parsed.src).toBe('cli');
    expect(parsed.tt).toBeDefined();
    expect(parsed.cx).toBeDefined();
  });

  it('handles zero estimated cost', () => {
    const task = createMinimalTask();
    const decision: RoutingDecision = {
      model: { id: 'free-model', name: 'Free Model' },
      strategy: 'cost',
      estimatedCost: 0,
      reason: 'Free tier',
    };

    const result = serializeRoutingMetadata(task, decision);
    const parsed = JSON.parse(result!);

    expect(parsed.ec).toBe(0);
  });

  it('handles all strategy types', () => {
    const strategies: Array<'performance' | 'balanced' | 'cost'> = [
      'performance',
      'balanced',
      'cost',
    ];

    strategies.forEach((strategy) => {
      const task = createMinimalTask();
      const decision: RoutingDecision = {
        model: { id: 'model-1', name: 'Model 1' },
        strategy,
        estimatedCost: 0.01,
      };

      const result = serializeRoutingMetadata(task, decision);
      const parsed = JSON.parse(result!);

      expect(parsed.st).toBe(strategy);
    });
  });
});
