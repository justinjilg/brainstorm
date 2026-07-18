# Brainstorm Self-Improvement Scoreboard

Program: iterative harness hardening with local Acronis models + stochastic review (Codex CLI anchor).
Full protocol: see the approved plan (plan → implement → smoke → stochastic review → fix → measure/gate/commit).
Full 75-probe eval and SWE-bench run at milestones (every 3rd iteration). Heuristic (no-Docker) SWE-bench
results never count as passes.

| iter | date | items | full eval (q3-next / gpt-oss / q3-coder) | SWE-bench (mode) | open P0/P1 | notes |
|---|---|---|---|---|---|---|
| 0 | 2026-07-18 | baseline (custom provider + 2 workspace fixes) | 52% / 28% / 33% | not run | 0 | Eval run from repo root, read-only probe tools. q3-next: 100% code-correctness, 36% multi-step. Weakest dims everywhere: tool-selection, multi-step — consistent with 8192-ctx assumption + missing maxOutputTokens (iter 1 targets). |
| 1 | 2026-07-18 | A B C D (+4 codex-found fixes) | dims: q3-next ts 36%= ms 36%= / q3-coder ts 27%= ms 21%+7 | not run | 0 | Codex anchor 4/4 precision; qwen3-coder reviewer 0/4; gpt-oss seat crashed -> iter-002 NEW-1 (tool-call id). Dip proved flake by re-run. |
| 2 | 2026-07-18 | NEW-1 streaming fix, F, G (+3 codex P1 fixes, +1 gpt-oss P1 fix) | gpt-oss full: 29% (tool-sel 40% +30, multi-step 21% +14, instr 80% +30; code-corr 10% = eval-design issue); re-anchor: q3-next cc 90%, q3-coder cc 80% | not run | 0 | Codex 7/7 precision running; gpt-oss seat now productive (7 findings, 1 verified+fixed); 2 delegated fixes landed first-try; harness finding: workflow steps accept empty artifacts. |
| 3 | 2026-07-18 | E H W (+4 codex fixes incl. discarded-middleware-return security hole) | gpt-oss 35% (+7; tool-sel 10→50, multi-step 7→29), q3-next 43%, q3-coder 35% (+2) | not attempted (docker down) | 0 | Codex 12/12 precision; both local reviewer seats died empty-output → iter-004 lead. HONEST READ: eval swings 100/90/50 on identical probes — cannot gate on it; falsification test + 6 dogfound bugs are the real evidence. See result.md. |
