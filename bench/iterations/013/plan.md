# Iteration 013 — Deterministic artifact verifiers

## Goal

Replace output-substring confidence with reproducible artifact evidence for the
frozen end-to-end suite.

## Scope

- Canonical sandbox path and symlink containment.
- Required file and contains/excludes checks.
- Valid JSON checks for infrastructure and policy artifacts.
- Baseline HTML document and responsive viewport checks.
- Shell-free, allowlisted, time-bounded command execution.
- Immutable setup fixtures except explicitly editable artifacts.
- Whole-workspace no-mutation proof and SHA-256 artifact evidence.

## Gate

- Named negative regressions for every containment and verification boundary.
- Full eval tests/typecheck green.
- Full contract preflight green.
