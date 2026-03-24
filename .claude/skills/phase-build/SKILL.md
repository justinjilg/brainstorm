---
name: phase-build
description: >
  This skill should be used when the user asks to "build a phase",
  "start the build loop", "run phase-build", "/phase-build",
  "build the next PR", "continue building", or mentions autonomous
  builder/reviewer workflow or phase automation. Executes one iteration
  of the builder/reviewer protocol against the plan file.
version: 0.1.0
---

# Phase Build — Builder/Reviewer Protocol

## Overview

Autonomous build loop where Claude Code (builder) implements features from the plan and optionally uses Codex (reviewer) for validation. Finds the next unmerged PR from the plan and executes one full build cycle.

## Quick Start

```
/phase-build
```

Or for continuous execution:
```
/loop 10m /phase-build
```

## Execution Protocol

1. **Fetch latest**: `git fetch origin`

2. **Find actionable PR**: Read `.claude/plans/stateful-soaring-wirth.md` for the plan. Check merged PRs with `gh pr list --state merged`. Find the first PR number from the plan that hasn't been merged yet.

3. **If no actionable PR**: Report idle and exit.

4. **Branch setup** (idempotent):
   ```bash
   git checkout main && git pull
   git checkout -b feat/prN-<feature>
   ```

5. **Build**: Implement all required changes per the PR spec from the plan. For each file listed in the spec:
   - Create new files or modify existing ones
   - Follow existing patterns in the codebase (ESM, tsup, Zod, .js imports)
   - Run: `npx turbo run build --force`
   - Fix any build errors (max 2 attempts, then `needs_human`)

6. **Commit + PR**:
   ```bash
   git add -A
   git commit -m "feat: <description> (PR #N)"
   git push -u origin feat/prN-<feature>
   gh pr create --title "<title>" --body "<body>"
   ```

7. **Merge** (if build passes): `gh pr merge N --merge --delete-branch`

8. **Compact**: Run `/compact` after each PR to free context.

9. **Continue**: Immediately find the next PR from the plan and repeat.

## 12-Package Checklist

Every PR evaluates impact on all packages:

| # | Package | Path |
|---|---------|------|
| 1 | shared | `packages/shared/` |
| 2 | config | `packages/config/` |
| 3 | db | `packages/db/` |
| 4 | providers | `packages/providers/` |
| 5 | router | `packages/router/` |
| 6 | tools | `packages/tools/` |
| 7 | core | `packages/core/` |
| 8 | agents | `packages/agents/` |
| 9 | workflow | `packages/workflow/` |
| 10 | hooks | `packages/hooks/` |
| 11 | mcp | `packages/mcp/` |
| 12 | cli | `packages/cli/` |

## Hard Limits

| Limit | Default | Effect |
|-------|---------|--------|
| `max_review_rounds` | 3 | → `needs_human` |
| `max_wall_clock_minutes` | 30 | → `needs_human` |
| Build failure after fix | 2 attempts | → `needs_human` |

## Anti-Loop Rules

1. **Circular Blocker Detection** — If same area gets 2+ blockers, identify the design tension before continuing
2. **Follow Reviewer's Suggested Fix** — Don't substitute simpler alternatives without proof
3. **Escalate Design Tensions Early** — Surface conflicts to user instead of iterating
4. **Auto-Bump on Trivial Work** — If remaining work < 10 lines, bump `max_review_rounds` by 1 once

## Continuous Execution

After each PR terminal state (merged or needs_human):
1. Run `/compact` (mandatory)
2. Immediately scan plan for next PR
3. Start without asking

If no PRs remain, report idle.
