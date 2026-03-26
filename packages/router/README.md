# @brainstorm/router

Task classification and intelligent model routing with 5 strategies.

## Key Exports

- `BrainstormRouter` — Main router: `route(prompt, options)` → model selection
- `classifyTask()` — Heuristic task classifier returning `TaskProfile`
- `CostTracker` — Per-session and daily cost tracking with budget enforcement

## Strategies

| Strategy | Use Case |
|----------|---------|
| `quality-first` | Best model for the task (default) |
| `cost-first` | Cheapest viable model |
| `combined` | Balance quality, cost, speed |
| `capability` | Route by measured eval scores |
| `rule-based` | Custom rules from config |

## Usage

```typescript
import { BrainstormRouter, classifyTask } from '@brainstorm/router';

const router = new BrainstormRouter(config, providers);
const { model, strategy } = await router.route('Refactor this component');
```
