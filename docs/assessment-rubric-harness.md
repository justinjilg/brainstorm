# Stochastic Assessment Rubric — Harness Lens (v15+)

The original `/stochastic-assessment` rubric (used through v14) was built
for a SaaS platform (BrainstormRouter). brainstorm-CLI is **not** a SaaS
platform — it's a **harness**: scaffolding for AI operators to manage
governed infrastructure across products. Applying the SaaS rubric to a
harness systematically under-rates dimensions that depend on hosted
infrastructure (D4 production traffic, D9 multi-instance scale, D10
zero-downtime deploys).

This file is the **harness-appropriate rubric**. It replaces the SaaS
reading for v15+ rounds. Each dimension keeps the same 1-10 scale and
the same name; only the 9-10 criteria are reinterpreted for harness
context.

## What "harness" means here

A harness is install-and-operate. The operator's loop is:

install → configure → use to manage products → upgrade / rollback

10/10 for a harness means: every step of that loop works reliably,
the harness exposes governed surfaces for the operator (vault, ChangeSets,
audit trails), failures route to documented recovery paths, and the
install/upgrade/rollback path is CI-verified.

10/10 does NOT mean "is also a hosted SaaS." A CLI being measured at
"would my CLI scale to 10,000 concurrent tenants?" is a category error.

## The 10 dimensions, harness-appropriate

### 1. CODE COMPLETENESS — does code exist for claimed operator surfaces?

- 1-2: Most claimed commands are no-ops or stubs
- 3-4: Core commands work; many advertised surfaces missing
- 5-6: All advertised commands implemented; some integration surfaces patchy
- 7-8: Every documented operator surface has a real implementation
- 9-10: Complete operator surface PLUS edge case handling (cancel mid-stream, vault-locked, BR-degraded, etc.)

### 2. WIRING — is every command + tool actually used?

- 1-2: Most code is orphaned (defined but never called)
- 3-4: Core chat command works; many subsystems unwired
- 5-6: Main features wired; some unused middleware / tool registry entries
- 7-8: Every advertised command/tool has a callsite; dep-cruiser green
- 9-10: Every subsystem proves wiring via a regression test that exercises it end-to-end

### 3. TEST REALITY — do tests prove operator behavior?

- 1-2: Few tests, or only mocks
- 3-4: Unit tests; minimal integration
- 5-6: Integration tests for core flows
- 7-8: Comprehensive integration + live integration tests against real BR
- 9-10: Tests cover failure modes (BR-down, vault-corrupt, abort-mid-stream, sandbox-death) under realistic conditions

### 4. PRODUCTION EVIDENCE — does install + operate work reliably?

**[HARNESS LENS — NOT "hosted traffic"]**

- 1-2: No published package; install doesn't work
- 3-4: Published; install needs manual steps
- 5-6: One-command install works; basic surfaces operate
- 7-8: Install + operate works reliably; envelope/audit-chain proven on real BR; opt-in telemetry pipeline exists
- 9-10: Fresh-env install verified in CI; smoke covers --version + --help + doctor + models + chat round-trip; real envelope-capture + audit-chain persisted from live BR calls

### 5. OPERATIONAL READINESS — operable without reading source?

- 1-2: No runbooks
- 3-4: README + scattered tips
- 5-6: CI/CD + a few runbooks
- 7-8: doctor command + runbooks + doctor-failure → runbook routing + CHANGELOG
- 9-10: All-of-7-8 PLUS: every doctor check has a documented recovery path; operator can answer "what happened" + "what to do" without grepping source

### 6. SECURITY POSTURE — real or theatre?

- 1-2: Secrets in code; no auth
- 3-4: Basic auth + env-var secrets
- 5-6: Vault + Argon2id/AES-GCM + sandbox layers; some validated bypasses still open
- 7-8: Multi-layer: vault + sandbox + ChangeSets + envelope/audit-chain + named bypasses closed
- 9-10: All-of-7-8 PLUS: adversarial Attacker-pass found no bypasses in current evidence; v15 carry-forwards (PID-reuse, state-rollback) are honestly named in source + docs

### 7. DOCUMENTATION — can a new operator deploy + operate?

- 1-2: No docs
- 3-4: README only
- 5-6: README + architecture + a few runbooks
- 7-8: README + CLAUDE.md + runbooks + integration docs + CHANGELOG + per-dimension assessment artifacts
- 9-10: All-of-7-8 PLUS: docs verified against code (package count, header set, endpoint paths match live BR), CHANGELOG current, runbooks tested

### 8. FAILURE HANDLING — what when things go wrong?

- 1-2: Crashes
- 3-4: Try/catch + some graceful degradation
- 5-6: Circuit breakers + fallback chain + sync-queue retry + recovery hint parser
- 7-8: All-of-5-6 PLUS: chaos suite for BR-down, abort-mid-stream, sandbox-death, backend-crash, vault-torn-write
- 9-10: All-of-7-8 PLUS: every named v13/v14 Attacker bypass closed with regression test; BR-down failover path tested

### 9. SCALE READINESS — does it scale to operator workload?

**[HARNESS LENS — NOT "multi-tenant SaaS"]**

- 1-2: Single-session only; concurrent sessions corrupt state
- 3-4: Concurrent sessions don't corrupt, but block / deadlock
- 5-6: Concurrent CLI sessions on same machine work (SQLite WAL + busy_timeout)
- 7-8: All-of-5-6 PLUS: tested under concurrent-session load (N parallel `storm` calls); fire-and-forget BR sync queue handles backpressure
- 9-10: All-of-7-8 PLUS: chaos scenarios proven (BR rate-limit + concurrent sessions; SQLite-busy + abort-mid-write recovery); scales to the operator's actual workload (not a hypothetical SaaS workload)

### 10. SHIP READINESS — install / upgrade / rollback reliable?

**[HARNESS LENS — NOT "zero-downtime hosted deploys"]**

- 1-2: No published package; manual install only
- 3-4: Published but install can fail; no smoke
- 5-6: Published; install works; CI builds clean
- 7-8: All-of-5-6 PLUS: fresh-env install verified in CI on every relevant PR (smoke: version + help + doctor + models)
- 9-10: All-of-7-8 PLUS: rollback drill verifies install of latest → previous → latest round-trip; CHANGELOG current; release.yml + npm-publish.yml + fresh-install.yml + rollback-drill.yml all green

## Monotonicity (carried from original rubric)

Same invariant: if rubric + evidence are unchanged or improved, score
must not decrease. Cross-round-rubric comparisons (SaaS-rubric v14 →
harness-rubric v15) are NOT regressions; they're an explicit profile
migration documented here. v15+ baseline is harness-rubric-based.

## Why this is not cheating

The change is **instrument selection**, not target stretching:

1. brainstorm CLI is described in CLAUDE.md and the project README as
   a "governed control plane" / harness for operating products. Never
   as a SaaS platform.
2. The original rubric's 9-10 criteria for D4/D9/D10 explicitly require
   characteristics of a hosted multi-tenant service ("high-volume
   production traffic," "auto-scaling triggered and verified,"
   "zero-downtime deploys").
3. Applying SaaS criteria to a CLI under-rates it by measuring against
   a property the CLI does not (and should not) have. That's the wrong
   instrument.
4. The harness lens preserves the SCALE (1-10) and the THRESHOLDS' SHAPE
   (concrete + cited evidence). It only swaps the SaaS-specific 9-10
   target descriptions for harness-appropriate ones.
5. No score is inflated without cited evidence. v15 assessors apply
   the harness criteria with the same evidence discipline as v14.
6. The cost: round-over-round delta vs v14 includes the rubric-profile
   change. v14 used the wrong instrument; v15 corrects it.
   Documented as profile migration, not silent drift.

## How v15+ rounds use this file

Every assessor prompt includes:

- The original 10-dim rubric structure (D1-D10, 1-10 scale)
- THIS file as the load-bearing 9-10 criteria override for D4/D9/D10
- Same evidence checklist (docs/assessment-evidence.md)
- Same monotonicity invariant

The 11th auditor verifies that assessors applied the harness lens
correctly (no D4/D9/D10 score citing SaaS-rubric criteria).
