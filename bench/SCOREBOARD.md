# Brainstorm Self-Improvement Scoreboard

Program: iterative harness hardening with local Acronis models + stochastic review (Codex CLI anchor).
Full protocol: see the approved plan (plan → implement → smoke → stochastic review → fix → measure/gate/commit).
Full 75-probe eval and SWE-bench run at milestones (every 3rd iteration). Heuristic (no-Docker) SWE-bench
results never count as passes.

| iter | date | items | full eval (q3-next / gpt-oss / q3-coder) | SWE-bench (mode) | open P0/P1 | notes |
|---|---|---|---|---|---|---|
| 0 | 2026-07-18 | baseline (custom provider + 2 workspace fixes) | 52% / 28% / 33% | not run | 0 | Eval run from repo root, read-only probe tools. q3-next: 100% code-correctness, 36% multi-step. Weakest dims everywhere: tool-selection, multi-step — consistent with 8192-ctx assumption + missing maxOutputTokens (iter 1 targets). |
