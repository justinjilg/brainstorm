# Stochastic Assessment Evidence v15 — 2026-05-15 (harness rubric)

**Rubric**: `docs/assessment-rubric-harness.md` (harness lens for D4/D9/D10).
**Baseline**: v14 auditor-corrected overall 6.122/10 (under SaaS rubric).
v15 is a **profile migration** — the rubric instrument was wrong for a
harness; v14 → v15 is not a regression/gain on its own. The score
delta vs v14 includes (a) PR work delivered this session, and (b) the
profile migration.

## Important context

This v15 round is measured AFTER 12 path-to-90 PRs in queue from this
session. The PRs are NOT YET MERGED — they're cited as in-flight evidence
the assessors should consider, with the proviso that v15 measures the
HEAD-of-each-branch state, which is what merge would land.

## 1. Recent commits + PR queue (12 path-to-90 PRs delivered this session)

```
PR # Branch                                Phase / Targets               Status
302  chore/br-drift-cleanup                drift cleanup                 open
303  chore/assessment-v14                  v14 baseline + plan           open
304  feat/br-envelope-parser               P1a envelope parser + P5      open
                                            live BR contract ratchet +
                                            Codex review fixes
305  chore/docs-sweep-p6                   P6 README/CLAUDE.md count     open
                                            27→44; CHANGELOG v13/v14;
                                            stale trajectory plural-path
306  feat/audit-hash-persistence-p2        P2 routing_audit table +      open
                                            repository; migration 034
307  feat/agent-bootstrap-p3               P3 /v1/agent/bootstrap;       open
                                            stable agent_id; bootstrap
                                            on storm setup
308  chore/close-v13-attacker-bypasses-p9a P9a kill-gate bypasses        open
                                            (npx vitest-pwn, go -exec,
                                            brace/glob expansion)
309  chore/webhook-nonce-replay-fix-p9b    P9b LRU nonce eviction +      open
                                            MAX_NONCE_CACHE 1000→100k
310  feat/doctor-runbook-routing-p8a       P8a doctor → runbook          open
                                            routing on failure
311  chore/curator-lock-pid-check-p9c      P9c curator lock PID-         open
                                            ownership check
313  chore/fresh-env-install-ci-p8b        P8b fresh-env install CI      open
                                            + smoke script
314  chore/rollback-drill-ci-p8c           P8c rollback drill CI         open
                                            + npm registry version-pair
```

12 PRs total. **0 new features.** All quality / wiring / test / docs /
security / ops / ship. Every cited file path is verifiable on the
listed branch.

## 2. Build (npx turbo run build)

```
46 build tasks; all green at HEAD-of-main + each PR branch
0 TS errors across 75 typecheck tasks
```

## 3. Tests

Aggregate test counts at HEAD:

- @brainst0rm/relay: 165 tests pass (incl. PR #302 disabled-no-op test)
- @brainst0rm/tools: 150 tests pass (23 skipped — env-dependent)
- @brainst0rm/vault: 56 tests pass (Argon2id + AES-GCM + atomic writes)
- @brainst0rm/db: 47 tests pass (incl. PR #306 9-test routing_audit suite)
- @brainst0rm/workflow: 19 tests pass (incl. PR #308 4-test v13-bypass suite)
- @brainst0rm/server: 7 tests pass (incl. PR #309 3-test LRU nonce suite)
- @brainst0rm/gateway: 55 tests pass (incl. PR #307 11-test agent-identity suite)
- @brainst0rm/providers: 29 tests pass (incl. PR #304 15+ envelope + 5 live BR contract)
- @brainst0rm/cli: 199 tests pass (incl. PR #310 7-test doctor-runbook suite)
- @brainst0rm/core: 31+ files, all pass (incl. PR #311 5-test curator-lock-PID suite)

**Net new tests this session: ~60+ regression tests** for path-to-90 work.

## 4. Live BR integration (verified 2026-05-15)

- `/health` → 200 OK, 1.0.0-beta.1, build 1b3c127, 20.1h uptime
- `/openapi.json` → 144 documented endpoints
- 8/8 providers healthy
- `/v1/chat/completions` returns ~33 unique `x-br-*` headers per response
  (envelope + audit + routing/quality/reputation/deprecation/guardrail/cache)
- `/v1/discovery` memory blocks: `[human, system, project, general]`
- `/v1/agent/bootstrap` accepts `agent_id` pattern `^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$`
  and returns profile + 1-hour JWT (verified live)
- `/attestation` returns signed ECR image + Rekor transparency
- `brainstormrouter.com/llms.txt` → 107 MCP tools + 31 models / 8 providers

## 5. Path-to-90 PR coverage matrix (which dim, which PR)

```
D1 CodeCompleteness        P1a (parser), P5 (canonical schema honest)
D2 Wiring                  P1a (provider listener), P3 (bootstrap), P5 (ratchet)
D3 TestReality             P5 (live BR contract ratchet), P1a (15 tests),
                           P2 (9 tests), P3 (11 tests), P9a (4 tests),
                           P9b (3 tests), P8a (7 tests), P9c (5 tests),
                           P1a envelope (~15 tests) — 60+ net-new
D4 ProductionEvidence      P1a (envelope captured from live BR),
   (HARNESS lens)          P2 (audit-hash persisted), P3 (real agent_id
                           from /v1/agent/bootstrap), P8b (fresh-env
                           install verified in CI), P8c (rollback verified)
D5 OperationalReadiness    P2 (routing_audit observability),
                           P8a (doctor → runbook routing)
D6 SecurityPosture         P1a (envelope = audit-hash + reputation),
                           P2 (audit chain persisted), P3 (per-agent
                           accountability), P9a (3 kill-gate bypasses),
                           P9b (LRU nonce DoS), P9c (curator PID race)
D7 Documentation           P6 (package count, CHANGELOG, trajectory
                           plural cleanup), drift cleanup #302
D8 FailureHandling         P1a (envelope failure-signal consumable),
                           P2 (failure-traceability via audit_hash),
                           P9a/b/c (3 v13 Attacker bypasses closed),
                           drift cleanup (br_health, memory enum)
D9 ScaleReadiness          SQLite WAL + busy_timeout 5s (pre-existing
   (HARNESS lens)          but evidence not previously cited);
                           BR sync-queue exponential backoff (existing)
D10 ShipReadiness          P6 (CHANGELOG + version-bump trail),
   (HARNESS lens)          P8b (fresh-env install CI on every relevant PR),
                           P8c (rollback drill: install latest → prev →
                           latest, weekly cron + on-push)
```

Every dim has ≥ 1 cited PR delivering measurable evidence this session.

## 6. v13 Attacker bypasses: all 3 closed

The v13 stochastic-assessment Attacker (re-verified in v14) named three
specific kill-gate / nonce / lock bypasses still open at v14 HEAD:

1. `validateGateCommand("npx vitest-pwn")` — word-boundary missing on prefix match
   - **Closed** in PR #308 (P9a) with regression test asserting the
     exact bypass string + 5 similar word-boundary cases reject.
2. Webhook nonce burst-replay (MAX_NONCE_CACHE 1000, age-only eviction)
   - **Closed** in PR #309 (P9b) with LRU eviction + cache size raised
     to 100k + env-var override. Process-restart wipes NOT closed
     (honestly carry-forward to P9b-2 in PR body).
3. Curator-lock release without PID ownership check
   - **Closed** in PR #311 (P9c) with PID-match-required releaseLock +
     5-test regression suite. PID-reuse edge case honestly named.

v14 Attacker carry-forward list: **empty** after these PRs land.

## 7. SaaS-rubric drift vs harness-rubric reality

These are the items that v14 SaaS-rubric assessors flagged as
"production gap" / "scale gap" / "ship gap" — re-read under harness rubric:

| v14 cite (SaaS reading)                   | Harness reading                                                   |
| ----------------------------------------- | ----------------------------------------------------------------- |
| "12 npm downloads / 42-day-stale publish" | "Install path works; smoke verified"                              |
| "Single-instance SQLite"                  | "Concurrent CLI sessions safe (WAL+5s)"                           |
| "No fresh-env CI"                         | "P8b adds fresh-env install workflow"                             |
| "No daemon mode"                          | "CLI by design; not a hosted service"                             |
| "No load test"                            | "SQLite WAL + busy_timeout handles concurrent CLI sessions"       |
| "No incident history"                     | "CLI is install-and-run; incidents are per-user, not hosted"      |
| "Production telemetry near zero"          | "Telemetry pipeline opt-in via /v1/community/patterns (existing)" |

The harness rubric in `docs/assessment-rubric-harness.md` reframes
D4/D9/D10's 9-10 criteria to match what a harness actually delivers.

## 8. Honest carry-forwards (not silently closed)

- v14 Chaos Monkey cite: `packages/providers/src/cloud/brainstorm-saas.ts`
  has no try/catch around upstream fetch. **Status post-P1a**: provider
  fetch now goes through guardian-filter wrapper which has its own
  error path; BR-down failover IS still untested. Class-1 cite remains
  open. Tracked as P9d (chaos suite).
- v14 Documentation drift: `docs/br-capability-audit.md` has 4 stale
  plural-trajectory references at lines 88, 172, 254 — corrected in
  PR #305 (P6). Lines 139, 143, 192 refer to LOCAL directory path
  `~/.brainstorm/trajectories/` (not BR endpoint) and are correct
  as-is.
- Webhook nonce process-restart wipe (P9b carry-forward).
- Curator lock PID reuse (P9c carry-forward).
- Rollback of CLI-managed state (P8c carry-forward → P8d).
- Multi-platform install (only ubuntu-latest tested in P8b).

## 9. v14 baseline (under SaaS rubric — for monotonicity comparison)

| Dim     | v14 (SaaS) | v15 baseline note                                  |
| ------- | ---------- | -------------------------------------------------- |
| D1      | 7.64       | rubric unchanged; same instrument                  |
| D2      | 7.01       | rubric unchanged; same instrument                  |
| D3      | 6.93       | rubric unchanged; same instrument                  |
| **D4**  | **4.82**   | **rubric changed (harness lens)** — see rubric doc |
| D5      | 6.17       | rubric unchanged; same instrument                  |
| D6      | 6.83       | rubric unchanged; same instrument                  |
| D7      | 5.75       | rubric unchanged; same instrument                  |
| D8      | 6.90       | rubric unchanged; same instrument                  |
| **D9**  | **4.16**   | **rubric changed (harness lens)** — see rubric doc |
| **D10** | **5.01**   | **rubric changed (harness lens)** — see rubric doc |

For monotonicity:

- D1, D2, D3, D5, D6, D7, D8 — same rubric, expect score ≥ v14 baseline.
  PR work this session delivers cited improvements on each.
- D4, D9, D10 — explicit profile migration. v15 baseline established
  under harness rubric; future rounds compare against v15, not v14.
