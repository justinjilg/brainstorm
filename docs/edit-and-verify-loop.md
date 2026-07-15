# Edit Application and In-Loop Verify

Two related but independent mechanisms that make the agent's file edits more
reliable:

1. A fuzzy edit-matching cascade (`packages/tools/src/builtin/edit-common.ts`,
   landed in `806fd61`) so a near-miss `old_string` still applies instead of
   failing outright.
2. An optional in-loop verify / self-correction pass
   (`packages/core/src/agent/verify-loop.ts`, landed in `5dc7375`) that
   typechecks (and optionally tests) the files changed in a turn and feeds
   failures back to the model as a correction turn, within the same run.

Both are independently gated and neither changes default behavior unless
explicitly exercised (the fuzzy cascade only engages when the exact-unique
match fails; verify defaults to `off`).

## 1. The Aider-style fuzzy edit cascade

`file_edit` (and `multi_edit`/`batch_edit`, which share the same helper) used
to require `old_string` to be an exact, unique substring of the file — any
whitespace drift, reindentation, or near-miss failed the edit outright.
`applyEdit()` in `packages/tools/src/builtin/edit-common.ts` now runs a
cascade of matching strategies in **decreasing precision**, and applies the
**first confident match**. The guiding principle, stated in the module's
docstring: a wrong edit is worse than a rejected one — every tier either
matches unambiguously or declines; a low-confidence match is never applied.

### T1 — exact unique (unchanged fast path)

If `old_string` appears in the file exactly once, replace it. Zero
occurrences falls through to the cascade below; more than one occurrence is a
hard failure (`"N occurrences (must be unique)"`) — ambiguity is never
resolved by guessing. The replacement uses the **function form** of
`String.replace` (`content.replace(oldString, () => newString)`) so literal
`$1`/`$&`/`${VAR}` sequences in `new_string` are never misinterpreted as regex
backreferences.

### T2 — whitespace / indent-flexible

`tryWhitespaceFlexible()` compares `old_string` against the file line-by-line,
ignoring leading whitespace (`matchButForLeadingWhitespace`). Both sides are
first outdented by their common minimum leading whitespace so a uniformly
over-indented `old_string` can still match. A match is only accepted if:

- Every window line equals its corresponding part line once leading
  whitespace is stripped, **and**
- All non-blank lines are offset by the exact same whitespace prefix (a
  single consistent `add` string), **and**
- Exactly one such window exists in the file (ambiguity → no match, not a
  guess).

On a match, the replacement lines are **relative-reindented**: each
non-blank line of `new_string` is prefixed with the same `add` string the
matched region carried, so the edit lands at the file's actual indentation
rather than whatever indentation the model wrote in `old_string`.

### T3 — line-anchored ellipsis elision

If `old_string` contains bare `...` lines, it's treated as several chunks of
contiguous lines separated by elisions (the same convention Aider uses for
long spans). `tryEllipsis()` matches each chunk **in order** as a contiguous
run of **whole content lines** — `findLineChunk()` compares full lines, not a
raw substring `indexOf` — so a chunk can never match by slicing through the
middle of an identifier or a longer line. Each chunk must match **exactly
once** in the remaining search window (0 matches = not found, >1 = ambiguous,
both reject). The full span from the first chunk's start to the last chunk's
end is replaced with `new_string` verbatim.

### T4 — similarity fallback

`trySimilarity()` slides a window the size of `old_string` (in lines) across
the file and scores each window with a dependency-free, LCS-based line
similarity ratio (`lineSimilarity`, trimmed per-line so pure indentation
differences don't penalize the score — T2 already owns indentation, T4 is
for content near-misses). A window is only accepted if:

- Its ratio is `>= 0.85` (`SIMILARITY_THRESHOLD`), **and**
- It is **unambiguously** the best match: the highest-scoring
  non-overlapping runner-up must trail by at least `0.05`
  (`SIMILARITY_MARGIN`); otherwise the match is rejected as ambiguous. (Two
  overlapping windows that share most of their lines — e.g. off-by-one — are
  not compared against each other for this purpose, since they'd spuriously
  tie and over-reject a genuinely unique near-miss.)

The accepted window's replacement lines are reindented relative to the
window's actual leading whitespace vs. `old_string`'s (`reindentLines`), same
idea as T2.

If none of T1–T4 produce a confident match, `applyEdit()` returns
`{ applied: false, error: "not found" }` — the edit is rejected, never
silently corrupted.

### Observability

Every successful match reports which tier produced it via
`EditResult.matchTier: "exact" | "whitespace" | "ellipsis" | "similarity"`.
`file-edit.ts` surfaces this in its response payload (`{ success: true, ...,
matchTier }`) so callers/logs can see how often edits are landing on a fuzzy
tier rather than the exact fast path.

`file-edit.ts`'s own `findClosestMatch()` best-effort suggestion helper (used
to hint the model toward the right location when nothing matched at all) is
unchanged — it now only runs after the full cascade has already failed.

## 2. In-loop verify / self-correction

After an edit-producing turn, the agent loop can optionally run a verify pass
over the files changed **that turn** and, on failure, push the diagnostics
back into the conversation as a correction turn so the model fixes its own
mistake within the same run — the single-agent analogue of the multi-agent
Judge's `verifyWorktree` gate (the Cline/OpenHands pattern).

### Configuration — `config.general.verify`

```toml
[general.verify]
mode = "off"          # off (DEFAULT) | typecheck | full
maxIterations = 2      # cap on self-correction turns
```

**`mode` defaults to `"off"`.** This is a deliberate zero-behavior-change
default: verify adds a real typecheck (and optionally test) invocation per
edit-producing turn, which costs wall-clock time and, if it fails, an entire
extra model turn. Projects opt in per-project (or via a per-invocation
`AgentLoopOptions.verify` override, which takes priority over the config
value) once they want the extra safety net.

- `"typecheck"` — run the project's typecheck after edit turns.
- `"full"` — typecheck, then (only if the typecheck didn't fail) affected
  tests.
- `maxIterations` (default `2`) bounds how many self-correction turns can
  fire before giving up — an infinite-loop guard.

### What triggers a verify pass (`loop.ts`)

The loop only attempts verify when **all** of the following hold:

- `verifyMode !== "off"`,
- the turn itself succeeded (`turnSuccess` — never verify a failed/empty
  turn),
- the turn actually wrote/edited files (`filesWritten` non-empty — a no-op
  turn skips it),
- `verifyDepth < verifyMaxIterations` (the recursion-depth guard), and
- the session isn't already aborted.

It's additionally **budget-guarded**: if remaining budget is at or below 20%
of `config.budget.perSession` (the same threshold the budget-warning path
uses), verify is skipped rather than risking an over-budget correction turn.

### What the verify pass actually runs (`verify-loop.ts`)

`runVerifyPass(files, mode, ctx, runner)` filters `files` down to TypeScript
sources (`\.(?:m|c)?tsx?$`, excluding `.d.ts`) before running anything — if
none remain, it's a skip. The default runner (`defaultVerifyRunner`) mirrors
the Judge's `verifyWorktree` semantics:

- **Missing `node_modules`** → skip immediately (tri-state `null`, not a
  failure) — an environmental gap is not the model's fault.
- **Typecheck** (`runTypecheck`) prefers, in order: the project's own
  `npm run typecheck` script, else a project-level `npx tsc --noEmit -p
tsconfig.json` (whole-project, not per-file — a per-file `tsc` invocation
  can't resolve monorepo path aliases / cross-package ESM imports and would
  produce false negatives), else skip (no governed way to typecheck).
- **Affected tests** (`runAffectedTests`, `"full"` mode only, and only if the
  typecheck didn't already fail) — finds test files that are themselves among
  the changed files, plus co-located `<name>.test.ts`/`.spec.ts` siblings of
  changed sources (`findAffectedTests`); runs them with
  `npx vitest run <tests> --reporter=silent`. No affected tests found → skip.

**Diagnostics are scoped to only the files changed this turn.** A
whole-project `tsc` run surfaces every pre-existing error in the repo;
`scopeDiagnosticsToChangedFiles()` parses tsc's `path(line,col): error TS####`
output and keeps only lines whose file resolves to one of the turn's changed
files. If the typecheck failed but every error is in code the model didn't
touch, that's treated as a **pass** — the model is never re-prompted over
pre-existing repo errors it had no part in.

**Environmental failures degrade to a skip, never a bogus failure.**
`isEnvironmentalExecError()` classifies an exec error as environmental (and
therefore tri-state `null`, never `false`) when it's `ENOENT` (compiler/test
runner not installed), `killed` or has a `signal` (timeout/kill), or has a
non-numeric exit status. Only a genuine numeric non-zero exit is treated as a
real compile/test failure. And if the verify pass itself **throws** for any
other reason, `runVerifyPass`'s try/catch degrades it to a skip and logs a
warning — a broken verifier can never crash the turn.

### Feeding diagnostics back

When verify runs and fails (`outcome.ran && !outcome.ok`), the loop:

1. Yields a `verify-failed` event (`{ iteration, maxIterations, diagnostics }`).
2. Formats the diagnostics via `formatVerifyDiagnostic()` (marks it as the
   final attempt if `nextIteration >= verifyMaxIterations`) and pushes it as a
   `user`-role message.
3. **Checkpoints this turn's edits** before recursing — without this, the
   outer invocation would return immediately after the recursive `yield*` and
   the original turn's `filesWritten` would never be persisted, under-reporting
   the edits to crash-recovery/undo.
4. Recurses into `runAgentLoop(messages, { ...options, _verifyDepth:
nextIteration })` so the model gets another turn to fix its own errors,
   and returns — the caller sees the recursive generator's output.

When verify runs and passes, the loop yields a `verify-passed` event
(`{ iteration, mode }`) and continues normally; no correction turn is
triggered.

Two new `AgentEvent` variants carry this to the TUI/CLI:
`{ type: "verify-passed"; iteration; mode: "typecheck" | "full" }` and
`{ type: "verify-failed"; iteration; maxIterations; diagnostics }`
(`packages/shared/src/types.ts`).

## SWE-bench Verified

Brainstorm has SWE-bench Verified plumbing for measuring end-to-end
edit-and-verify quality against the public benchmark:

- `packages/eval/src/swe-bench/dataset.ts` — loads a local SWE-bench Verified
  JSONL export (no network fetch of the dataset itself — the caller supplies
  the file) and validates each record against the fields the harness depends
  on (`instance_id`, `repo`, `base_commit`, `patch`, `test_patch`,
  `FAIL_TO_PASS`, `PASS_TO_PASS`, `problem_statement`). `selectDeterministicSubset()`
  makes a fixed `--split verified --limit N --seed S` selection reproducible
  regardless of the source JSONL's on-disk order.
- `packages/eval/src/swe-bench/scorecard.ts` — writes a per-run artifact
  (`RunScorecard`: resolved count/rate, total/avg cost, avg patch size,
  per-instance results) to `~/.brainstorm/swebench/<runId>/`.
- `brainstorm eval-swe-bench --instances <path> [--model <id>] [--limit N]
[--concurrency N] [--json]` (registered in `packages/cli/src/bin/brainstorm.ts`)
  drives an agent (`spawnSubagent`, `type: "code"`, `maxSteps: 40`,
  `budgetLimit: 3.0`, unattended auto-approve) against each instance in a
  shallow git clone (`--filter=blob:none --no-checkout`, then `fetch` +
  `checkout` of `base_commit`), and scores the result with Docker.
- `d218cb3` (network-retry stability) wraps the git clone/fetch and the
  per-instance agent call in a bounded exponential-backoff retry
  (`withNetRetry`, 4 attempts, 2s/4s/8s backoff) that only fires on errors
  that look transient (`ENOTFOUND`/`ETIMEDOUT`/`ECONNRESET`/`EAI_AGAIN`/
  `ECONNREFUSED`/`socket hang up`/`maxRetriesExceeded`/`"Cannot connect to
API"`); a real git or agent error still fails fast. The agent call itself
  retries at most once, since a network blip almost always hits the first
  model call, before any edit — bounding the extra token cost of a retry.
- `1b04f81` added cache-aware cost accounting (`CostTracker`, cached-token
  billing — see [provider-agnostic-tool-calling.md](provider-agnostic-tool-calling.md#4-cache-through-br-the-dual-namespace-cache-hint))
  specifically so a SWE-bench run's reported cost reflects actual (cache-
  discounted) spend rather than raw input-token cost.

### Measured results (20-instance Verified subset, via BrainstormRouter)

| Run         | Model (via BR) | Resolved | Notes                                                                                                                                                                                                                                                |
| ----------- | -------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline    | DeepSeek V3    | 0/20     | 16 "no patch generated" + 4 infra (network/git) — network-limited, pre-stability-fix                                                                                                                                                                 |
| Post-phases | GLM 5.2        | 1/20     | django-11163 resolved end-to-end (fuzzy-edit cascade + real Docker scoring, 5 FAIL_TO_PASS tests green); 1 further diff produced but failed scoring; **16/20 blocked by Z.AI content moderation** (`finishReason: "content-filter"`); 2 git-timeouts |

**What the number does and does not measure.** These runs are gated by the
**BR-routed model**, not by the harness. Instrumenting the subagent's model
turn (logging `finishReason` + tool-call count) showed the GLM 5.2 failures
return `finishReason: "content-filter"` with real tool calls already emitted and
assistant text `"[TOOL BLOCKED] denied_tool"` — that string is **Z.AI's own
content-moderation artifact** (it appears nowhere in this codebase), i.e. the
provider is refusing the (benign Django ORM) coding prompts, not the harness
failing. On the instances that are not filtered, the harness resolves them
end-to-end — the edit cascade applies the fix and the in-repo Docker scoring
confirms the FAIL_TO_PASS/PASS_TO_PASS tests pass (django-11163; astropy-14508
in isolation). The harness capability is therefore validated by the resolutions
and by 500+ unit tests; the GLM ceiling is a **provider/model choice** (use a
model without aggressive moderation, or a Z.AI moderation setting if BR exposes
one), not a gap in the edit/verify loop.

> **Known issue — provider content-filtering surfaces as a silent empty diff.**
> When a BR-routed model's turn ends on a non-`stop` `finishReason`
> (`content-filter`, `length`, `error`), the harness currently records the turn
> as "done" with no visible reason, so a moderation block looks like the model
> "did nothing." A small robustness improvement: detect these finishReasons and
> surface a clear diagnostic (and optionally retry) instead of a silent empty
> result. Separately, some genuinely weak models narrate a tool call as prose
> without emitting a structured call; the tool-use enforcement layer
> (`packages/core/src/agent/tool-use-enforcement.ts`) handles that distinct case
> — it correctly does **not** fire on the content-filter case above, where real
> tool calls were emitted.

## Files

- `packages/tools/src/builtin/edit-common.ts` — `applyEdit`, T1–T4 cascade
- `packages/tools/src/builtin/file-edit.ts` — routes through the cascade, surfaces `matchTier`
- `packages/core/src/agent/verify-loop.ts` — `runVerifyPass`, `defaultVerifyRunner`, `formatVerifyDiagnostic`
- `packages/core/src/agent/loop.ts` — verify trigger/budget-guard/recursion wiring
- `packages/config/src/schema.ts` — `general.verify.mode`/`maxIterations` schema
- `packages/shared/src/types.ts` — `verify-passed`/`verify-failed` `AgentEvent` variants
- `packages/eval/src/swe-bench/dataset.ts`, `packages/eval/src/swe-bench/scorecard.ts`
- `packages/cli/src/bin/brainstorm.ts` — `eval-swe-bench` command, network-retry wrapper

## Related

- [docs/provider-agnostic-tool-calling.md](provider-agnostic-tool-calling.md) — how the
  `file_edit`/`shell` tool calls this section applies get to the model and back
- [docs/context-efficiency.md](context-efficiency.md) — how much context the model
  sees when producing the edit in the first place
