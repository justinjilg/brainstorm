# Iteration 014 — Result: e2e verifier hardening + abort-safe runner + CLI

Follows the review of iter/013-artifact-verifiers. Three commits.

## 1. Verifier + gate hardening (review P1s) — `ddf3b44`
- **Fail closed on snapshot errors.** `snapshotSandbox` used `realpathSync` on symlink entries, which throws
  `ENOENT` on a dangling link — a model planting `ln -s /nonexistent x` under a `noMutation` task crashed
  `verifyE2EArtifact`. Now uses `readlinkSync` (raw target, no crash) and the `noMutation` snapshot is wrapped
  so any error records a FAILED check.
- **Process-group teardown.** `spawn` uses `detached:true` and timeout/settle kills the whole group
  (`process.kill(-pid)`), so a non-detached grandchild forked by `node --test` can't outlive the run and tamper
  after checks pass. (A grandchild that re-detaches via `setsid` escapes process groups — only a PID namespace
  contains it, which the Docker executor provides.)
- **Docker-jailed executor.** `createDockerCommandExecutor()` / `buildDockerRunArgs()` run the allowlisted
  command in a throwaway `docker run` with `--network=none`, `--read-only` host, `--cap-drop=ALL`, uid 1000,
  and only the sandbox mounted rw.
- **Gate.** Require ≥1 concrete check per task (gate + parser); fingerprint version-binding vs `git HEAD`
  (a `sha256` change under an unchanged `suiteId` is drift). TOCTOU: `sandboxPath` returns the canonical path;
  null bytes rejected.

## 2. Abort-safe e2e runner with Docker wired in — `7539e58`
`runE2ETrial` / `runE2ESuite`: the missing connection from the frozen suite to real Brainstorm executions.
- Materializes fixtures (escape-rejecting), captures the `noMutation` baseline BEFORE the model runs.
- Drives the REAL agent loop under `withWorkspace`+`withSession`, strict model pin
  (`allowModelFallback:false`).
- **Abort-safe**: the task timeout aborts the loop via the signal threaded into `runAgentLoop` — not a lost
  `Promise.race` (fixes the probe runner's leak).
- Verifies with `resolveDefaultExecutor()`: Docker jail when available, else the local process-group executor.
- Scores five INDEPENDENT axes (correctness / efficiency / resilience / governance; quality left `undefined`
  until a rubric grader) + `silentFailure` (claimed success but didn't verify) + `stateCorruption`.
- **Safety gate**: `requireJail` defaults TRUE for the adversarial domain — those tasks refuse to run (errored,
  before any model work) unless commands run in the jail.

## 3. `brainstorm eval-e2e` CLI — `b68e8a4`
`brainstorm eval-e2e --model <id> [--trials N] [--task ID] [--suite path] [--no-jail] [--json]`. Strict pin;
Docker jail by default; `--json` on clean stdout; fails closed (exit 1) on unreadable suite / unknown task.
Registered in `cli-subcommand-registry` (101/101).

## Gate
eval 113 + cli 271 green; typecheck clean; contract-check 19/19. New tests: +7 verifier/gate hardening,
+10 runner (executor resolution, adversarial requireJail gate, setup-escape rejection, independent axis
scorers). Runner's live agent-loop path is validated by the live-model proof, not unit tests (no model here).

## Remaining
- **Quality axis** stays `undefined` until the versioned rubric grader (`web-quality-v1` /
  `documentation-quality-v1`) is wired — the next independent-quality piece.
- The Docker executor's live path is Docker-gated (unavailable in this environment); its argv is unit-tested,
  and the first real jailed run should be watched once a daemon is up.
