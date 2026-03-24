---
description: "Run the phase-build builder/reviewer protocol. Finds the next PR from the 20-PR plan and executes one iteration of the build loop with Codex as reviewer."
---

# Phase Build — Builder/Reviewer Loop for Brainstorm CLI

Read the plan at `.claude/plans/stateful-soaring-wirth.md` for the full 20-PR roadmap.

## Execution

1. **Fetch latest**: `git fetch origin`

2. **Find actionable PR**: Read the plan file, find the next PR that hasn't been merged. Check existing branches (`feat/pr*`) and open PRs to determine what's done.

3. **If no actionable PR**: Report idle and exit.

4. **Branch setup** (idempotent):

   ```bash
   git checkout feat/prN-<feature> 2>/dev/null || git checkout -b feat/prN-<feature> main
   ```

5. **Route by PR state**:

### Planning Route (new PR, no branch exists)

a. Read the PR spec from the plan file
b. Draft implementation plan covering:
   - Files to create/modify (from plan spec)
   - Risk assessment
   - Verification strategy
c. Proceed to Build Route

### Build Route

a. Implement all required changes per the PR spec
b. Run verification:
   ```bash
   npx turbo run build --force
   npm link --prefix packages/cli
   ```
c. Run specific tests from the PR spec
d. Commit changes with descriptive message
e. Push branch and create PR via `gh pr create`

### Review Route (Codex reviews the PR)

After creating the PR, invoke Codex to review:

```bash
CODEX_PR=$(gh pr view --json number -q .number)
echo "Review PR #$CODEX_PR for the brainstorm CLI project. Check:
1. Does the implementation match the PR spec in the plan?
2. Are there any bugs, security issues, or missing edge cases?
3. Does it follow existing patterns in the codebase?
4. Are all files from the spec addressed?
Respond with: approved, changes_requested, or needs_human." | codex --approval-mode full-auto
```

If `changes_requested`: fix findings and re-push (max 3 rounds). If `approved`: report ready to merge.

### On Approval

1. Run `/simplify` on changed files
2. Re-verify: `npx turbo run build --force`
3. Report PR ready for merge

## 10-Package Checklist

Every PR evaluates impact on all packages. Implement required changes; note others as N/A.

| # | Package | Path | Description |
|---|---------|------|-------------|
| 1 | shared | `packages/shared/` | Types, errors, logger |
| 2 | config | `packages/config/` | Zod schemas, TOML loader |
| 3 | db | `packages/db/` | SQLite migrations, repositories |
| 4 | providers | `packages/providers/` | Cloud + local model adapters |
| 5 | router | `packages/router/` | BrainstormRouter, strategies, classifier |
| 6 | tools | `packages/tools/` | Built-in tools, registry |
| 7 | core | `packages/core/` | Agentic loop, session management |
| 8 | agents | `packages/agents/` | Agent profiles, NL parser, prompts |
| 9 | workflow | `packages/workflow/` | Workflow engine, presets, context filter |
| 10 | cli | `packages/cli/` | Commander commands, Ink TUI |

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

After each PR reaches terminal state (merged or needs_human):

1. Run `/compact` (mandatory)
2. Immediately find next PR from plan
3. Start without asking

## The 20-PR Plan

PRs 1-5 (Tier 1 Core):
1. Streaming markdown rendering
2. Permission model (auto/confirm/plan cycling)
3. Checkpoint/revert system
4. Git integration (tools + context)
5. Context compaction

PRs 6-10 (Tier 2 Power):
6. Conversation management (resume/fork)
7. @-mentions for file references
8. Hooks system
9. MCP client
10. Subagents

PRs 11-15 (Tier 3 Advanced):
11. Skills/slash commands
12. Auto-memory via RMM
13. Plan mode
14. CI/CD mode
15. Multimodal

PRs 16-20 (Beyond Parity):
16. Temporal.io durable workflows
17. E2B Firecracker execution
18. Three-layer context engine
19. Kernel-level sandbox
20. Additional tools (19 total)
