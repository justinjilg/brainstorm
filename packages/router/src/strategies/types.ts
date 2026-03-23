import type { TaskProfile, ModelEntry, RoutingContext, RoutingDecision, StrategyName } from '@brainstorm/shared';

export interface RoutingStrategy {
  name: StrategyName;
  select(
    task: TaskProfile,
    candidates: ModelEntry[],
    context: RoutingContext,
  ): RoutingDecision | null;
}
