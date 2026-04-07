---
name: multi-model-routing
description: Leverage brainstorm's intelligent model routing. Use when optimizing cost, selecting models for specific tasks, or understanding routing decisions.
---

# Multi-Model Routing

Brainstorm routes each task to the optimal model using Thompson sampling across providers. Understanding the routing system lets you make better decisions about cost vs quality.

## Routing Strategies

| Strategy      | When                                                     | Tradeoff                       |
| ------------- | -------------------------------------------------------- | ------------------------------ |
| quality-first | Complex reasoning, code generation, architecture         | Higher cost, better results    |
| cost-first    | Simple queries, bulk operations, high volume             | Lower cost, adequate quality   |
| combined      | General use (default)                                    | Balanced                       |
| capability    | Tasks requiring specific features (vision, long context) | Feature-driven                 |
| learned       | After enough usage data                                  | Thompson sampling optimization |

## Cost-Aware Tool Selection

Before expensive operations, use `cost_estimate` to predict cost:

```
cost_estimate({ prompt: "the task description", strategy: "quality-first" })
```

For batch operations, prefer `cost-first` strategy to reduce spend.

## Model Override

Use `set_routing_hint` to override routing for the next request:

```
set_routing_hint({ model: "claude-haiku-4-5", reason: "simple search task" })
```

## Capability Scores

Each model has scores across 7 dimensions:

- toolSelection, toolSequencing, codeGeneration
- multiStepReasoning, instructionFollowing
- contextUtilization, selfCorrection

Use these when choosing models for specific tasks — a model with high toolSequencing is better for multi-step workflows than one with only high codeGeneration.

## Fallback Chain

Every routing decision includes a fallback chain. If the primary model fails:

1. First fallback (same quality tier, different provider)
2. Second fallback (lower tier)
3. Last resort (cheapest available)

The `--events` flag shows every routing decision and retry in real-time.
