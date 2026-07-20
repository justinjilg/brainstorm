# Iteration 013 — Result: artifact evidence replaces self-assessment

## Delivered

- `verifyE2EArtifact()` returns one deterministic pass/fail plus every named
  check, artifact SHA-256, byte count, and duration.
- Required paths are confined both lexically and after realpath resolution, so
  a sandbox symlink cannot smuggle an external file into a passing result.
- Command checks use `spawn(argv)` with `shell:false`, a v1 executable allowlist,
  a reduced environment, output cap, and task timeout.
- Setup files not declared as editable artifacts must remain byte-identical.
  This prevents test weakening and adversarial-input rewriting.
- Structured JSON is parsed; a matching substring in malformed JSON does not
  pass. Static web work must be an HTML document with responsive viewport
  metadata.
- `noMutation` tasks compare full before/after sandbox snapshots.

## Regression evidence

Seven focused verifier tests cover a passing executable artifact, fixture
tampering, symlink escape, malformed JSON, incomplete web structure, unexpected
workspace mutation, and rejection of a shell command.

## Verification

- Focused verifier: 7/7 green.
- Eval: 96/96 tests and typecheck green.
- Contract preflight: 19/19 green.
