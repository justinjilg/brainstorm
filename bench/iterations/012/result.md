# Iteration 012 — Result: CLI reports what actually happened

## Delivered

- Versioned JSON result with complete canonical `RunOutcome`.
- Explicit requested model, final model, strict-pin state, and fallback-used
  fields.
- `--strict-model` refuses an unavailable pin and disables router, circuit, and
  emergency fallback substitution while retaining same-model recovery.
- Exit contract: succeeded `0`, failed/aborted/error `1`, partial/usage `2`.
- JSONL error events preserve name and message instead of serializing `Error`
  as `{}`.
- Human output includes aggregate status, initial stop cause, and recovery path.

## Dogfood findings converted to regressions

1. The first strict-pin test found that clearing router fallbacks was
   insufficient: the emergency fallback generator repopulated them. The loop
   now gates both paths and the regression asserts no `model-retry` occurs.
2. The first live JSON proof failed `JSON.parse(stdout)` because internal pino
   records followed the result on stdout. Structured JSON/JSONL modes now route
   all logger output to stderr, guarded by a shared regression test.

## Live proof

`acronis:h200/gpt-oss-120b` completed a strict pinned run with:

- exactly one parseable stdout line;
- `success=true`, `outcome.status=succeeded`;
- requested model equal to final model;
- `fallbackUsed=false`;
- six diagnostic lines isolated on stderr.

## Verification

- Shared: 63/63 tests, typecheck, and build green.
- CLI: 271/271 tests, typecheck, and build green.
- Core: 641/641 tests, typecheck, and build green. The initially failing
  emergency-fallback regression passes after the fix.
- Contract preflight: 19/19 green.
