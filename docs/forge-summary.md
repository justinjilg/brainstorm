# Forge Assessment — Brainstorm

**Date:** 2026-04-09 | **Tier:** Deep | **Agents:** 10 | **Rounds:** R1 + R2 (5 pairs) + R3 (cross-exam)

---

## Auditor Honesty Score: 9/10

Agent 11 (Bias Auditor) verified the synthesis against all 8 bias categories. No SOFTENED, OMITTED, INFLATED, REFRAMED, ADDED_OPTIMISM, CHERRY_PICKED, BANNED_WORD_VIOLATION, or EVIDENCE_FABRICATION findings. Math verified correct. All 20 measurable claims in the synthesis traceable to specific evidence fields. One point deducted: PROPERTY_CORRECTNESS mean of 2.9 is pulled by Agent 6 (Attacker) scoring 5 based on cryptographic property correctness while all other agents scored 1-4 based on `propertyBasedTests=0`. This interpretive divergence is documented but does not require score correction.

---

## Overall Score: 4.1 / 10

Mean of 15 dimension scores after R1 (10 agents), R2 (5 pairs), and R3 (cross-exam) revisions.

---

## Score Distribution

| Dimension              | Final Score | StdDev | Min | Max | Status    |
| ---------------------- | ----------- | ------ | --- | --- | --------- |
| DEPENDENCY_HEALTH      | 7.3         | 1.10   | 5   | 9   | —         |
| FAILURE_HANDLING       | 4.9         | 0.54   | 4   | 6   | —         |
| ARCHITECTURE_QUALITY   | 5.2         | 0.75   | 4   | 6   | —         |
| WIRING                 | 5.4         | 1.11   | 4   | 7   | CONTESTED |
| CODE_COMPLETENESS      | 5.0         | 0.63   | 4   | 6   | —         |
| SECURITY_POSTURE       | 5.0         | 1.00   | 4   | 7   | CONTESTED |
| TEST_REALITY           | 4.4         | 0.92   | 3   | 6   | —         |
| API_CONTRACT_INTEGRITY | 4.4         | 0.66   | 3   | 5   | —         |
| DOCUMENTATION          | 3.7         | 1.00   | 2   | 5   | —         |
| SHIP_READINESS         | 3.2         | 0.98   | 2   | 5   | CONTESTED |
| RESILIENCE             | 3.1         | 0.30   | 3   | 4   | —         |
| PROPERTY_CORRECTNESS   | 2.9         | 1.22   | 1   | 5   | CONTESTED |
| OPERATIONAL_READINESS  | 2.9         | 0.83   | 2   | 4   | CONTESTED |
| SCALE_READINESS        | 2.2         | 0.40   | 2   | 3   | —         |
| PRODUCTION_EVIDENCE    | 1.4         | 0.66   | 1   | 3   | —         |

**No dimension reached StdDev > 1.5 after R2/R3 revisions.**

---

## Contested Dimensions

Five dimensions were disputed in R2 pair debates and/or R3 cross-examination:

**WIRING** — R2 Pair 1: Optimist (8) vs Pessimist (4). R3 cross-exam reduced Agent 1 from 8 to 5. Defense FAILED: 22 confirmed dead exports including 5 of 6 routing strategies cannot be reconciled with a score of 8. Final mean: 5.4.

**PROPERTY_CORRECTNESS** — R2 Pair 3: Auditor (1) vs Optimist (3). R3 cross-exam resolved Agent 1 at 2. `propertyBasedTests=0` is a confirmed count field, not an absence of evidence. `red-team.test.ts` has `testsErrors=false`. Final mean: 2.9 (includes Agent 6 outlier of 5 based on cryptographic property correctness interpretation).

**SECURITY_POSTURE** — R2 Pair 4: Attacker (5) vs Senior Engineer (6). R3 cross-exam confirmed floor=5. Defense FAILED on three required paths: (A) server.ts 1450 lines 0 tests, (B) jwtSecret soft-failure allows server startup, (C) red-team test does not assert blocked outcomes. Final mean: 5.0.

**OPERATIONAL_READINESS** — R2 Pair 5: Operator (4) vs Investor (3). No consensus override. Operator credits 3 real PRR-positive artifacts; Investor discounts monitoring-manifest as setup instructions not deployed. Final mean: 2.9.

**SHIP_READINESS** — R2 Pair 1: Optimist (5) vs Pessimist (3). No consensus override. Optimist uses CLI artifact standard; Pessimist uses production service standard. Deciding evidence: 5 of 6 routing strategies are dead exports. Final mean: 3.2.

---

## Risk Register (Top 15)

| #   | Risk                                                                                               | Severity | Dimension(s)          |
| --- | -------------------------------------------------------------------------------------------------- | -------- | --------------------- |
| R03 | server.ts (1450 lines) has zero tests — POST /api/v1/god-mode/execute never tested for auth bypass | CRITICAL | SECURITY_POSTURE      |
| R04 | Empty jwtSecret produces startup warning, not process exit — unauthenticated server startup path   | HIGH     | SECURITY_POSTURE      |
| R01 | 22 confirmed dead exports: 17 tool exports + 5 of 6 routing strategies (83% of router primary API) | HIGH     | WIRING                |
| R02 | 42% of packages (11/26) have zero test files — server, gateway, onboard, orchestrator, scheduler   | HIGH     | CODE_COMPLETENESS     |
| R06 | Unbounded taskEventQueue at loop.ts:242 — 170 unbounded push calls, confirmed OOM vector           | HIGH     | RESILIENCE            |
| R26 | 80% of test files (37/46) skip error conditions — agent loop and KAIROS loop have no error tests   | HIGH     | FAILURE_HANDLING      |
| R07 | Zero runbooks — verified absent by grep across docs/ in a 788-commit project                       | HIGH     | DOCUMENTATION         |
| R05 | No production deployment — MTTR=null, all DORA metrics are commit-velocity not operational         | HIGH     | PRODUCTION_EVIDENCE   |
| R10 | 5 synchronous IO hot paths in agent loop and memory manager block the Node.js event loop           | HIGH     | SCALE_READINESS       |
| R11 | Code coverage disabled — 661 tests provide no measurable line coverage                             | MEDIUM   | TEST_REALITY          |
| R09 | 21 Docker sandbox tests skipped in CI — process isolation layer not verified in standard CI        | MEDIUM   | SECURITY_POSTURE      |
| R12 | 3 cross-layer architecture violations — core->agents, core->tools, mcp->tools                      | MEDIUM   | ARCHITECTURE_QUALITY  |
| R08 | propertyBasedTests=0, mutationTestingAvailable=false across 77,909 source lines                    | MEDIUM   | PROPERTY_CORRECTNESS  |
| R16 | red-team.test.ts has testsErrors=false — adversarial tests do not assert blocked outcomes          | MEDIUM   | SECURITY_POSTURE      |
| R17 | Monitoring manifest is setup instructions, not deployed monitors                                   | MEDIUM   | OPERATIONAL_READINESS |

Full risk register (38 risks) in `docs/forge-evidence/synthesis/risks.json`.

---

## Maturity Placement

**CNCF Level: SANDBOX**

No production deployment. Zero confirmed organizations using in production. Single contributor. No published artifact adoption metrics. CNCF Sandbox requires production use by at least 2 organizations. This project does not meet that bar.

**DORA Tier: LOW**

| Metric              | Measured                                             | Elite Threshold        |
| ------------------- | ---------------------------------------------------- | ---------------------- |
| Deploy Frequency    | Commits to main only — no production deploys         | Multiple times per day |
| Lead Time           | 112 hours median (4.7 days)                          | Under 1 hour           |
| Change Failure Rate | 0 (no production history, not evidence of stability) | 0–5%                   |
| MTTR                | null                                                 | Under 1 hour           |

DORA metrics for this project measure development velocity to a local CLI artifact. They do not measure production operational maturity because there is no production system.

---

## Verified Strengths

- **Zero CVEs** across all severity levels — both npm audit and security audit confirm clean dependency tree
- **12 wiring points** confirmed with specific file:line citations in brainstorm.ts and loop.ts
- **AES-256-GCM + Argon2id** at OWASP recommended parameters (memory=65536KB, iterations=3) with derived key zeroed after use
- **22 registered security middlewares** with distinct non-overlapping purposes: egress-monitor, trust-propagation, content-injection-filter, approval-friction
- **ChangeSet state machine** enforces simulation→approval→execution for all destructive actions via packages/godmode/src/changeset.ts
- **661 tests pass, 0 failures** across a 77,909-line codebase with 788 commits
- **Pino structured logging** (NDJSON to stderr, BRAINSTORM_LOG_LEVEL env control) and Sentry with PII scrubbing configured
- **Foundation layer instability** correctly measured: shared=0.00, config=0.08, db=0.08

---

## Recommendations

### Immediate (This Week)

1. **Change server.ts line 113 from console.warn to process.exit(1) when jwtSecret is empty.** One line of code. Closes the unauthenticated server startup path. [R03, R04]

2. **Add 3 integration tests to server.ts** with usesRealIO=true: unauthenticated request returns 401, JWT alg:none rejected, expired token rejected. [R03]

3. **Cap taskEventQueue at 1000 entries** in packages/core/src/agent/loop.ts:242. Add a backpressure event when cap is hit. 10-line fix, immediate memory safety impact. [R06]

4. **Enable vitest coverage with v8 provider.** Run once to establish baseline. No threshold required yet — measurement first. [R11]

### One Week

5. **Write 3 runbooks** covering: startup and health verification, vault unlock failure recovery, API key rotation. Link each to a monitoring-manifest.json monitor. [R07]

6. **Delete or wire the 22 dead exports** — start with the 5 dead routing strategies. 83% of the router package's primary public API is dead code. [R01]

7. **Add error-path tests to loop.integration.test.ts** covering provider 503, tool crash, context overflow. The agent loop is the most critical execution path with no error-path coverage. [R26]

8. **Convert memory/dream-runner.ts and memory/manager.ts file operations to async fs/promises.** These are the highest-frequency synchronous IO paths. [R10]

9. **Add 10 property-based tests using fast-check** targeting Thompson sampling reward bounds and vault encrypt/decrypt round-trip invariants. [R08]

### One Month

10. **Deploy to staging environment.** Record the first production deployment timestamp. MTTR, DORA lead time, and deployment frequency cannot be measured without a deployed system. [R05]

11. **Deploy the 11 monitoring-manifest monitors** and verify Sentry DSN receives real events. Converts operational intent into deployed capability. [R17]

12. **Add smoke tests for server, gateway, and scheduler packages.** Each package needs one test. These 3 are operationally critical with zero coverage. [R02]

13. **Write 3 SLO definition documents** (not code metrics): CLI startup time, vault unlock per session, first chat token latency. Link each to a monitoring-manifest.json monitor. [R18]

14. **Fix 3 cross-layer architecture violations** starting with core->agents (lowest blast radius). Prevents compounding technical debt as each layer grows. [R12]

15. **Add Dependabot or Renovate** with a policy that high/critical CVE PRs block merge. Maintains the current 0-CVE state automatically. [R20]

16. **Enable the 21 skipped Docker sandbox tests** in a dedicated CI job with Docker-in-Docker. Process isolation is not a luxury test category for a tool-execution engine. [R09]

---

## Summary Statement

Brainstorm is a 26-package TypeScript monorepo with 77,909 source lines, 788 commits, 1 contributor, and 661 passing tests across 15 of 26 packages. The dependency tree has zero CVEs. The vault uses AES-256-GCM with Argon2id at OWASP-recommended parameters. The security middleware stack registers 22 middlewares with distinct non-overlapping purposes. The ChangeSet state machine enforces approval gates for destructive actions.

Against these positives: 22 exports across tools and router are confirmed unreachable (17 tool exports, 5 of 6 routing strategies). Code coverage measurement is disabled. 42% of packages have zero test files including the HTTP server and LLM billing gateway. The server package implementing the primary external API has 1450 source lines and zero tests. Empty jwtSecret produces a startup warning rather than a hard exit. 80% of test files skip error conditions. Zero runbooks exist by verified grep. There is no production deployment, making MTTR unmeasurable and all DORA metrics a proxy for development velocity rather than operational maturity. Five synchronous IO hot paths and an unbounded task queue constrain scaling beyond single-session use.

The highest-scoring dimension is DEPENDENCY_HEALTH at 7.3. The lowest is PRODUCTION_EVIDENCE at 1.4. The overall score of 4.1 reflects a codebase that can be assembled and invoked today, with real security controls in code, but without the test coverage, operational procedures, or production history required for a production service classification.

---

_Assessment files: `docs/forge-results.json`, `docs/forge-evidence/synthesis/scores.json`, `docs/forge-evidence/synthesis/risks.json`, `docs/forge-evidence/synthesis/audit.json`_
