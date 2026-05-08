# Product Journey Test Plan (2026-05-08)

Concrete enumeration of the end-to-end test scenarios that should exist before BHv1 is considered "9/10." Today's test suite (~199 test files under `packages/`) is unit-strong but **journey-weak** — there are no tests that span Desktop → server → relay → God Mode → ChangeSet → audit. This doc lists the journeys, maps them to BH-TST requirements from the PRD, and tracks landing.

This is a plan document. Each journey lands as a separate test PR scoped against its row.

## Journey index

| ID  | Journey                                                                                                                               | PRD ref    | Status                                                                                  | Owner     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------- | --------- |
| J-1 | Operator imports a fresh harness, indexer ticks, drift surfaces, ChangeSet apply round-trips intent → runtime → drift clears          | BH-TST-001 | **TODO**                                                                                | Phase 0/1 |
| J-2 | ChangeSet-required tool dispatch via MSP executor: simulate → preview → approve → execute → audit                                     | BH-TST-002 | **TODO** (depends on remote ChangeSet handshake — PRD P0-5)                             | Phase 4   |
| J-3 | Router scope isolation: tenant A and tenant B both run the same task type; tenantA bad outcome does not affect tenantB Thompson state | BH-TST-003 | **TODO** (depends on `RoutingScope` — PRD BH-BR-001)                                    | Phase 3   |
| J-4 | ChangeSet restart durability: pending ChangeSet survives process restart; idempotent re-approval                                      | BH-TST-004 | **TODO** (depends on persistent ChangeSet drafts — PRD BH-CS-001)                       | Phase 4   |
| J-5 | Harness loop overlap protection: long-running indexer doesn't race with next tick                                                     | BH-TST-005 | **DONE** ✓ — PR #293 (`packages/harness-loop/src/__tests__/loop.test.ts:overlap guard`) | Phase 0   |
| J-6 | Desktop Business workspace smoke (Playwright/Electron): load harness → see Plan → switch to Inspect → see loop log                    | BH-TST-006 | **TODO**                                                                                | Phase 6   |

## Journey specifications

### J-1 — Harness lifecycle round-trip (Phase 0/1)

**Why first.** Validates the substrate that PR #291 shipped end-to-end. If J-1 doesn't pass, nothing downstream is trustworthy.

**Setup.**

- Spin up a tmp harness with a minimal `business.toml` and one customer file.
- Open a `HarnessIndexStore` against a tmp DB.
- Construct `HarnessLoopRunner` with deterministic clock + sink.

**Steps.**

1. Run indexer once → assert artifact appears in index with correct hash.
2. Edit the customer file's intent value (mrr_intent change).
3. Run customer-drift detector once → assert drift is recorded.
4. Construct `ApplyIntentToRuntimeChangeSet` with mock runtime apply.
5. Simulate → assert preview describes the right diff.
6. Apply → assert mock runtime received the new value.
7. Re-run customer-drift detector → assert drift is gone (or resolved).

**Test home.** `packages/harness-drift/src/__tests__/journey.test.ts` (new file).

### J-2 — Remote ChangeSet handshake (Phase 4)

**Blocked on.** PRD P0-5 (msp-executor sends `simulate: false` and acknowledges ChangeSet-gated tools "are not handled in v1"). Cannot land until the remote simulate handshake exists.

**Setup.**

- Mock MSP endpoint that returns `CHANGESET_REQUIRED` per `docs/platform-contract-v1.md:197`.
- `MspExecutor` instance configured against the mock.

**Steps.**

1. Dispatch a mutating tool with `simulate=true`.
2. Receive simulation response with preview.
3. Persist the preview as a local ChangeSet draft.
4. Approve via Desktop ChangeSet center (or direct API).
5. Re-dispatch with `simulate=false` and the approved idempotency_key.
6. Assert mock received the approved execution call.
7. Assert audit_log has both simulate and execute entries with linkage.

**Test home.** `packages/msp-executor/src/__tests__/changeset-handshake.test.ts` (new).

### J-3 — Router scope isolation (Phase 3)

**Blocked on.** PRD BH-BR-001 (`RoutingScope` not yet defined; learned strategy keys outcomes globally by `taskType:modelId`).

**Setup.**

- Two tenants: `tenantA`, `tenantB`.
- Both run task type "code-generation."
- Both have access to the same model pool.

**Steps.**

1. tenantA runs 10 tasks; record bad outcomes (timeouts, failures) on model X.
2. Verify tenantA's learned strategy for "code-generation" deprioritizes model X.
3. tenantB runs first task of "code-generation" → model X must NOT be deprioritized for tenantB.
4. Cost budget per tenant is independently tracked.

**Test home.** `packages/router/src/__tests__/scope-isolation.test.ts` (new).

### J-4 — ChangeSet restart durability (Phase 4)

**Blocked on.** PRD BH-CS-001 (active ChangeSets stored in in-memory Map; lost on process restart).

**Setup.**

- ChangeSet engine with persistence backend.
- Pending ChangeSet in `proposed` state.

**Steps.**

1. Process A creates ChangeSet (proposed).
2. Process A exits without approving.
3. Process B starts; ChangeSet is recoverable from persistence.
4. Process B approves the same ChangeSet idempotency_key twice.
5. Assert exactly one execution; second call returns cached result.

**Test home.** `packages/godmode/src/__tests__/changeset-durability.test.ts` (new).

### J-5 — Harness loop overlap protection (DONE)

Already shipped in PR #293 (Group B item B1).

Tests at `packages/harness-loop/src/__tests__/loop.test.ts`:

- `overlap guard: concurrent runOnce(loop) yields one started + one skipped`
- `overlap guard releases after completion — next runOnce works`
- `overlap guard is per-loop — different loops can run concurrently`

### J-6 — Desktop Business workspace smoke (Phase 6)

**Blocked on.** No Playwright/Electron test infra in the repo today.

**Setup.**

- Playwright + Electron test runner configured under `apps/desktop/e2e/`.
- Headless Electron with a tmp harness fixture.

**Steps.**

1. Boot Electron with tmp harness.
2. Wait for Business workspace to render.
3. Click Plan tab → assert identity header + seven-folder grid visible.
4. Click Inspect tab → assert verify pills appear, loop-event log mounts.
5. Trigger one indexer run via UI → assert event appears in log.
6. Click Operate tab → assert at least the indexer-run button is mounted.

**Test home.** `apps/desktop/e2e/business-workspace.spec.ts` (new — requires Playwright config).

## What is _not_ in scope for this plan

Out-of-scope (separate plans):

- Single-package unit tests (already 199+ test files)
- Code-graph indexing tests (own suite under `packages/code-graph`)
- Sandbox runtime tests (own suite under `packages/sandbox*`)
- Performance/load tests (separate concern; PRD §Phase 6)

## Tracking conventions

When a journey lands:

1. Move its row to **DONE** ✓ with PR #
2. Cite the test file path and the highest-level assertion that proves the journey
3. Update `docs/desktop-surface-status-2026-05-08.md` if a new live cell unlocked

When a journey is blocked:

1. Mark `**TODO**` with the blocker (PRD ref or PR #)
2. Do not move to DONE until the blocker also lands
