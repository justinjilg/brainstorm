---
description: "Review the last N commits for quality, style, and potential issues"
model_preference: cheap
max_steps: 3
---

# Commit Review

Review the last {{n:5}} commits in this repository:

1. Run `git log --oneline -{{n}}` to see recent commits
2. For each commit, check:
   - Commit message follows conventional commits (feat/fix/refactor/etc.)
   - Changes are focused (single responsibility)
   - No obvious issues in the diff
3. Report any findings with commit hash and recommendation
