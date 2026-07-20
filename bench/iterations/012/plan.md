# Iteration 012 — Truthful CLI outcomes and model pins

## Goal

Make non-interactive runs auditable enough to serve as the transport for the
end-to-end benchmark and external automation.

## Scope

- Include the canonical `RunOutcome` in `run --json`.
- Distinguish requested and final model and report whether fallback occurred.
- Add strict model pins that prohibit every cross-model fallback path.
- Derive shell exit status from the outcome, including a distinct partial code.
- Preserve `Error` diagnostics in event JSONL.
- Guarantee structured-output stdout contains only its JSON protocol.

## Gate

- CLI, core, and shared tests/typechecks green.
- Strict-pin tests cover missing models and unusable responses.
- Live local-model stdout parses as exactly one JSON value.
- Full contract preflight green.
