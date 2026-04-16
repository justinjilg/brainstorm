# 20-Bug Fix Plan

Companion to BUG-SCAN.md findings set (2026-04-16). Each bug maps to exactly one commit.

## Guiding rules

1. **One bug → one commit.** No bundling. Makes revert trivial if a fix regresses something.
2. **Every fix ships with a test.** Reproduce the bug first (red), then fix (green). Integration > unit where the bug crosses layers.
3. **No behavior change beyond the bug.** If a file needs unrelated cleanup, that's a separate commit.
4. **Shared helpers land before the bugs that use them.** One dedicated commit per helper.
5. **Verify in current code before editing.** Working-tree has uncommitted drift on several target files.

## Execution order

```
Helpers → Wave 1 (data integrity) → Wave 2 (security) → Wave 3 (liveness) → Wave 4 (correctness)
```

Reason: Wave 1 fixes protect the data layer before Wave 2's security fixes touch it. Wave 3 adds abort plumbing that Wave 4's correctness work can rely on.

---

## Shared helpers (build first, 2 commits)

### H1. `packages/shared/src/fs-atomic.ts` — atomic-write helper with crash-safe temp names

Used by: #9 (vault), #12 (memory — side-benefit).

Contract:

```ts
atomicWriteFile(path: string, data: string | Buffer, opts?: { mode?: number }): void
```

- Temp name is `${path}.${process.pid}.${randomUUID().slice(0,8)}.tmp` (no collisions across processes).
- Write → fsync → rename. On throw, unlinks temp and rethrows.
- Plain sync: callers already `writeFileSync`, we're not changing async shape.

Test: two child processes racing on the same output — both tempfiles exist, both renames succeed, final file is one of the two payloads intact (no half-mix).

### H2. `packages/shared/src/abort-signals.ts` — `linkSignals(...signals)` + `onAbort(signal, fn)`

Used by: #13 (SSE), #15 (subagent).

Contract:

```ts
linkSignals(...signals: (AbortSignal | undefined)[]): AbortSignal  // aborts when any upstream aborts
onAbort(signal: AbortSignal, fn: () => void): () => void  // returns off()
```

- Listener cleanup is manual via returned off(). No leaks when upstream signal is long-lived.

Test: two parent signals, child fires on first abort; off() removes listener (no fire after detach).

---

## Wave 1 — Data integrity (4 commits)

### #8. `fix(db): use created_at in cleanupOldRecords, not started_at`

File: `packages/db/src/client.ts:52-56`

Fix: `started_at` → `created_at` in both SQL statements. Keep the `catch {}` (it legitimately covers first-run where tables don't exist), but narrow it to only swallow `SqliteError.code === "SQLITE_ERROR"` with a message matching missing-table.

Test: seed a session with `created_at = Date.now()/1000 - 91*86400`, call `cleanupOldRecords`, assert row deleted. Without the fix, the test catches the thrown error; with it, the row is gone.

LOC: ~10.

### #9. `fix(vault): use pid+uuid suffixed temp for concurrent-safe writes`

File: `packages/vault/src/vault.ts:295-299` (also `writePayload` path).

Fix: replace `const tempPath = this.vaultPath + ".tmp"` with `atomicWriteFile(this.vaultPath, ...)` from H1.

Test: spawn two processes via `child_process.fork`, both call `set()` on the same vault path. After both exit, the vault opens cleanly and contains at least one of the two written keys (not corrupted).

LOC: ~5 + H1 from shared.

### #20. `fix(core): serialize memory writes and store full path for eviction`

File: `packages/core/src/memory/manager.ts` (two changes, one commit).

1. **TOCTOU (245-256):** wrap `enforceCapacity() → writeEntry()` in a class-level `saveQueue` (Promise chain). Every `save()` awaits the previous one.
2. **Basename (825-835):** change `fileSizes` to store `{ dir, file, fullPath }`; eviction uses `fullPath` directly instead of reconstructing via `join(entry.dir, basename(entry.file))`.

Test:

- TOCTOU: fire 10 concurrent `save()` calls with sizes summing to 1.5x cap. Final total ≤ cap.
- Eviction: create `a/b/note.md` and `a/c/note.md` (same basename), force eviction of `a/b/note.md`, assert `a/c/note.md` still exists.

LOC: ~40.

### #12. `fix(core): detect and reject memory ID slug collisions`

File: `packages/core/src/memory/manager.ts:156-160`

**DECISION REQUIRED #1:** reject OR disambiguate on collision?

- **Reject** (safer, clearer): `if (existing && existing.name !== entry.name) throw SlugCollision(...)` — surfaces the problem to the user.
- **Disambiguate** (smoother): append `-2`, `-3` suffix to slug until unique — lossy if original name is the intent.

My recommendation: **reject**, because memory names are user-authored and a conflict indicates real ambiguity.

Test: save `"Project: Foo!"`, then `"Project Foo"` → second raises. First entry's file on disk unchanged.

LOC: ~15.

---

## Wave 2 — Security (7 commits)

### #2. `fix(cli): prompt GitHub PAT via promptPassword (no terminal echo)`

File: `packages/cli/src/init/org-init.ts:74`

Fix: import existing `promptPassword` from `packages/cli/src/bin/brainstorm.ts:2080` (extract to `packages/cli/src/util/prompt.ts` first in its own commit if shared, otherwise inline). Replace `rl.question` call.

Test: mock stdin to send a secret, assert the echoed terminal output contains no bytes of the secret. (Ink/Node: capture process.stdout.write mock.)

LOC: ~10, plus optional 1 extraction commit.

### #1. `fix(cli): /vault get requires --reveal, otherwise returns only length + last-4`

File: `packages/cli/src/bin/brainstorm.ts:8108` (and parallel at :2221 for CLI `vault get`).

**DECISION REQUIRED #2:** mask format?

- Length-only: `"ANTHROPIC_API_KEY = [redacted, 103 chars]"`.
- Last-4: `"ANTHROPIC_API_KEY = …4a8f (103 chars)"`.
- Require `--reveal` flag to print plaintext.

My recommendation: **length-only by default**; add `/vault get KEY --reveal` that prints full. No partial prefix — prefix exposes the provider-identifying high-entropy segment.

Test: run `/vault get TEST_KEY`, assert output contains no substring of the actual value.

LOC: ~20 across two sites.

### #3. `fix(godmode): require timestamp on signed events, reject if missing or stale`

File: `packages/godmode/src/signing.ts:83-88`

Fix: change `if (event.timestamp)` to `if (!event.timestamp) return false`. Guard against `NaN` explicitly: `if (Number.isNaN(eventTime)) return false`.

Test: verify returns false for `{ timestamp: undefined }`, `{ timestamp: "invalid" }`, and a fresh-enough valid timestamp still passes.

LOC: ~8.

### #4. `fix(server): treat missing x-github-delivery as suspect webhook`

File: `packages/server/src/github-webhook.ts:143`

Fix: `if (!deliveryId) return true` (treat missing as "replay-ish" — drop and log, since real GitHub always sends it).

Test: POST webhook with valid signature but no delivery header → response 400 + logged suspect event; handler side-effects did not run.

LOC: ~5.

### #5. `fix(godmode): encode URL path segments in MSP connector`

File: `packages/godmode/src/connectors/msp/client.ts:84, 87, 173, 180, 184, 188, 198, 202, 216`

Fix: add a private `encodeId(id: string)` that calls `encodeURIComponent` and rejects `..`, `/`, control chars. Use it in every path-building template. Audit all MSP-like connector files for the same pattern — if found, same commit covers all (same class of bug, same fix).

Test: inject `id = "../admin"` → connector throws with clear message, never reaches fetch.

LOC: ~30 with audit.

### #6. `fix(workflow): sanitize stepId before using it in artifact filenames`

File: `packages/workflow/src/artifact-store.ts:69-72, 130`

Fix: add `sanitizeStepId(raw)` that rejects `..`, path separators, null, and length >100. Apply at both write and read sites. Extra belt-and-braces: assert `resolve(filePath)` starts with `resolve(dir) + sep`.

Test: write with `stepId = "../../etc/test"` → throws before touching disk; read with same → returns null.

LOC: ~25.

### #7. `fix(godmode): atomic approve with CAS, mark failed-execute as failed not draft`

File: `packages/godmode/src/changeset.ts:104-168`

Two bugs, one commit (same call path):

1. Add per-id in-flight Set: `if (inflight.has(id)) return { success:false, message:"approval in progress" }`. Set/clear in try/finally.
2. Change line 154 and 160: `cs.status = "failed"` (not `"draft"`). A separate explicit `retryChangeSet(id)` call can rehydrate draft if needed — and we'll build that helper here too, so retry still works, just intentional.

**DECISION REQUIRED #3:** after failed execute, should a new draft be auto-created (current intent — "retryable") or should the operator explicitly opt in via `retryChangeSet`?

My recommendation: **explicit retry**, because a partial-mutation failure (HTTP wrote, then timed out reading the response) can silently re-trigger the mutation.

Test: (a) two concurrent `approve(id)` — only one executor runs. (b) executor returns `{success:false}` → `cs.status === "failed"` and re-calling `approve(id)` returns "not draft".

LOC: ~40.

---

## Wave 3 — Liveness & abort plumbing (6 commits)

### #13. `fix(server): pipe client-disconnect into runAgentLoop abort`

File: `packages/server/src/server.ts:573-592` (and `handleChat` parallel).

Fix: in `handleChatStream`, create `const ac = new AbortController()`. `res.on("close", () => ac.abort())`. Pass `ac.signal` into `runAgentLoop` options. Requires `runAgentLoop` to accept and propagate `signal` to `streamText` — verify it already does (it takes `abortSignal` in the options object).

Test: start a chat-stream request, destroy the client socket after 500ms, assert `runAgentLoop` observes the abort event in <1s and returns; no further LLM tokens charged.

LOC: ~15.

### #15. `fix(core): thread parent abort signal into spawned subagents`

File: `packages/core/src/agent/subagent.ts:440, 495`

Fix: add `parentSignal?: AbortSignal` to `SubagentOptions`. Use `linkSignals(budgetAbort.signal, parentSignal)` from H2. Callers in `agent/loop.ts` must forward the loop's signal.

Test: spawn subagent with parent signal; abort parent; assert subagent streamText abort fires within one event tick.

LOC: ~20.

### #14. `fix(core): watchdog timer detects stream stall independent of stream progress`

File: `packages/core/src/agent/loop.ts:855-882`

Fix: move the timeout check out of the for-await body. Use `setInterval(checkStall, 1000)` that, if `Date.now() - lastEventTime > STREAM_TIMEOUT_MS`, calls `abortController.abort(new StreamStallError())`. Clear in finally.

Test: mock a stream that opens but never yields. Assert the loop returns with stall-error within `STREAM_TIMEOUT_MS + 2s` (vs hanging forever today).

LOC: ~25.

### #17. `fix(scheduler): sweep zombie "running" rows on startup`

File: `packages/scheduler/src/trigger.ts` + `packages/scheduler/src/repository.ts`

**DECISION REQUIRED #4:** zombie-run policy?

- **Mark as `crashed`** and never retry (conservative).
- **Mark as `crashed`** and requeue with a retry counter (resilient, but risks retrying destructive tasks).
- **Time-based**: only sweep runs older than N minutes.

My recommendation: **mark as crashed + retry counter ≤ 1**, with tasks tagged `destructive: true` in their definition getting no automatic retry.

Fix: on `TriggerRunner.start()`, run `UPDATE scheduled_task_runs SET status='crashed', completed_at=? WHERE status='running'`. Requeue per policy. Also fixes BUG in scheduler `complete()` that stamps `completed_at` on `status='running'`: rename the dual-purpose function, or add a `markRunning()` variant that only writes status.

Test: insert a "running" row, restart trigger runner, assert row becomes "crashed" and a new dispatch proceeds (available > 0).

LOC: ~50.

### #16. `fix(tools): unref background shell children so CLI exits cleanly`

File: `packages/tools/src/builtin/shell.ts:281-307`

Fix: `child.unref()` after spawn, keep `backgroundTasks` Map in place (already allows status polling).

Test: spawn a `sleep 100` background task, then `process.exit(0)` the parent — assert child is left behind but parent exits immediately (no hang).

LOC: ~2.

### #11. `fix(core): error or warn when resumeFrom not in selected phases`

File: `packages/core/src/plan/orchestration-pipeline.ts:209-223`

**DECISION REQUIRED #5:** error or warn-and-run-all?

- **Error**: surfaces the user's probable misunderstanding.
- **Warn + run everything**: least surprising for someone expecting "resume from here or earlier if that's gone".

My recommendation: **error**, because silently doing nothing is the current bug.

Fix: before the loop, compute `if (options.resumeFrom && !phases.includes(options.resumeFrom)) throw ResumeTargetNotSelected(...)`.

Test: call pipeline with `resumeFrom: "refactor"` and phases that exclude refactor → throws. Including refactor → runs as expected.

LOC: ~10.

---

## Wave 4 — Correctness (3 commits)

### #10. `fix(workflow): move confidenceRetries declaration outside while loop`

File: `packages/workflow/src/engine.ts:124-125`

Fix: move `let confidenceRetries = 0` before the while loop. Reset explicitly when `stepIndex` advances past the step.

Test: fake agent returning low-confidence three times; assert workflow hits `MAX_CONFIDENCE_RETRIES` and continues with the last output, not looping forever.

LOC: ~8.

### #18. `fix(desktop): structured readiness protocol + guaranteed timer cleanup`

File: `apps/desktop/electron/main.ts:122-138, 227-247`

Two bugs, one file, one commit:

1. **Readiness**: backend emits `{"type":"ready"}\n` on stdout (structured). Main parses line-by-line, sets `backendReady=true` only on exact match. Remove stderr substring check.
2. **Timer leak**: in the `backend.on("exit")` drain loop, also call `clearTimeout` on any pending chat-stream timer keyed by `${id}-timer`. Add a `timers: Map<string, NodeJS.Timeout>` alongside `pending`; clear all on exit.

Test: (a) log `"database not ready"` to stderr → `backendReady` stays false. (b) start chat-stream, kill backend, assert no spurious "timed out" event fires N minutes later.

LOC: ~30.

### #19. `fix(orchestrator): use typed status field, not string-prefix match`

File: `packages/orchestrator/src/engine.ts:196-204` (and `executeTask` contract).

Fix: add a `status: "ok" | "failed"` field to `TaskResult`. Count failures via `r.status === "failed"` instead of summary string. Keep `summary` free-text. Update callers in `orchestrator/src/*` to set status explicitly.

Test: return a successful task with `summary: "FAILED: 0 of 100"` and `status: "ok"`; assert run status is `"completed"` (today it's `"partial"`).

LOC: ~25 across contract + callers.

---

## Open decisions (user input required)

| #   | Bug | Question                                            | Recommendation                                       |
| --- | --- | --------------------------------------------------- | ---------------------------------------------------- |
| 1   | #12 | Reject or disambiguate slug collisions?             | Reject                                               |
| 2   | #1  | Mask format for `/vault get`?                       | Length-only + `--reveal` flag                        |
| 3   | #7  | After failed execute, auto-draft or explicit retry? | Explicit retry                                       |
| 4   | #17 | Zombie-run policy?                                  | Crashed + retry ≤ 1, destructive tasks no auto-retry |
| 5   | #11 | `resumeFrom` not in phases — error or warn?         | Error                                                |

---

## Testing strategy

- **Per-bug test** lives adjacent to the code: `packages/xxx/src/__tests__/yyy.test.ts`.
- **Regression coverage** for each bug: the red test from "repro first" step stays in the suite.
- **No mocks of the database** for fixes #8, #17, #20 — hit real SQLite in a temp dir (per existing `feedback_test_what_you_ship` memory: schema tests hide dead paths).
- **Security fixes** (#1-#7) each need a negative test that proves the vector is closed — not just a positive test that the happy path still works.

## Rollout & verification

1. Create feature branch `fix/20-critical-bugs`.
2. Build helpers H1, H2 (2 commits).
3. Land waves in order, one commit per bug, running `npx turbo run test` after each.
4. Before final merge: re-run the bug-scan subagent prompts against head to confirm all 20 report as STILL LIVE → FIXED.
5. Squash only within helpers (H1+H2 → single helpers commit) if reviewer prefers; otherwise keep 22 commits for full traceability.

## Estimated scope

- **Commits**: 22 (2 helpers + 20 fixes).
- **LOC touched**: ~440 source + ~300 test.
- **Parallel wall-time**: ~2 focused sessions if done sequentially; shorter if waves 2–4 split across operators after wave 1 lands.
