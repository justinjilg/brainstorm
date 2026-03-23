import type { TaskProfile, ModelEntry, RoutingContext, RoutingDecision } from '@brainstorm/shared';
import type { RoutingRule } from '@brainstorm/config';
import type { RoutingStrategy } from './types.js';

export function createRuleBasedStrategy(rules: RoutingRule[]): RoutingStrategy {
  return {
    name: 'rule-based',

    select(task: TaskProfile, candidates: ModelEntry[], _context: RoutingContext): RoutingDecision | null {
      for (const rule of rules) {
        if (!matchesRule(rule, task)) continue;

        if (rule.model) {
          const model = candidates.find((m) => m.id === rule.model && m.status === 'available');
          if (model) {
            return {
              model,
              fallbacks: candidates.filter((m) => m.id !== model.id && m.status === 'available').slice(0, 3),
              reason: `Rule matched: ${JSON.stringify(rule.match)} → ${model.name}`,
              estimatedCost: estimateCost(model, task),
              strategy: 'rule-based',
            };
          }
        }

        if (rule.preferProvider) {
          const providerModels = candidates
            .filter((m) => m.provider === rule.preferProvider && m.status === 'available')
            .sort((a, b) => a.capabilities.qualityTier - b.capabilities.qualityTier);
          if (providerModels.length > 0) {
            return {
              model: providerModels[0],
              fallbacks: providerModels.slice(1, 4),
              reason: `Rule matched: prefer provider ${rule.preferProvider} → ${providerModels[0].name}`,
              estimatedCost: estimateCost(providerModels[0], task),
              strategy: 'rule-based',
            };
          }
        }
      }

      return null; // No rule matched
    },
  };
}

function matchesRule(rule: RoutingRule, task: TaskProfile): boolean {
  const { match } = rule;
  if (match.task && match.task !== task.type) return false;
  if (match.complexity && match.complexity !== task.complexity) return false;
  if (match.language && match.language !== task.language) return false;
  return true;
}

function estimateCost(model: ModelEntry, task: TaskProfile): number {
  const { input, output } = task.estimatedTokens;
  return (
    (input / 1_000_000) * model.pricing.inputPer1MTokens +
    (output / 1_000_000) * model.pricing.outputPer1MTokens
  );
}
