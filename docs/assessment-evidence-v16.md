=== Phase 1 evidence sweep — v16 ===

## 1. git log (last 20 commits)

b303a03 fix(ci): drop @brainst0rm/web filter — apps/web is gitignored (#329)
f4a6711 fix(ci): exclude desktop/web/image-builder from npm-publish build (#328)
29ba014 chore: release v0.14.1 — reconciliation + 24 PR stack (#327)
8931b40 chore(ci): multi-platform install matrix for P8b (ubuntu + macos + windows) (#317)
07520f7 feat(p2b): wire BR envelope listener into routing_audit writer (#324)
fb3748d chore(precommit): auto-regen tool catalog when builtin tools change (#323)
41fda4e test(core): agent-loop end-to-end chaos suite (P9d-2) (#325)
a0caa3b feat(db): downgrade-detection guard (P8d state-rollback) (#326)
58bfdee feat(cli): storm doctor → runbook routing on failure (path-to-90 P8a) (#310)
453a7f8 feat(db): routing_audit table + repository for BR envelope persistence (P2) (#306)
6cc6291 fix(br-client): align with live BR surface (drift cleanup from BR audit 2026-05-15) (#312)
c709dee chore(br): drift cleanup against api.brainstormrouter.com 1.0.0-beta.1 (#302)
34be6d2 fix(workflow): close v15 Attacker flag-loader bypass class (P9a-2) (#316)
abdc2c7 fix(workflow): close 3 v13 Attacker kill-gate bypasses (path-to-90 P9a) (#308)
a628d65 fix(core/memory): curator lock PID-ownership check (path-to-90 P9c) (#311)
abb9cb0 feat(gateway): claim BR agent_id on storm setup (path-to-90 P3) (#307)
3c8b230 fix(server): LRU nonce cache for GitHub webhook replay protection (P9b) (#309)
537a400 test(db): D9 concurrent-session load test (path-to-90 P9e) (#320)
e26aaf7 test(workflow): validateGateCommand corpus coverage (58 tests) (#321)
59541f2 test(providers): BR-down chaos suite + export fetch wrapper (path-to-90 P9d) (#322)

## 2. build

```
@brainst0rm/cli:build: ESM ⚡️ Build success in 679ms
@brainst0rm/cli:build: DTS ⚡️ Build success in 1358ms
@brainst0rm/cli:build: DTS dist/index.d.ts 47.00 B

 Tasks:    46 successful, 46 total
Cached:    46 cached, 46 total
  Time:    75ms >>> FULL TURBO

```

## 3. typecheck

```

 Tasks:    77 successful, 77 total
Cached:    35 cached, 77 total
  Time:    20.493s

```

## 4. test summary

```
@brainst0rm/mcp:test: npm error command failed
@brainst0rm/mcp:test: npm error command sh -c vitest run
 ERROR  @brainst0rm/harness-fs#test: command (/Users/justin/Projects/brainstorm/packages/harness-fs) /opt/homebrew/opt/node@22/bin/npm run test exited (1)

 Tasks:    56 successful, 72 total
Cached:    43 cached, 72 total
  Time:    18.733s
Failed:    @brainst0rm/harness-fs#test

 ERROR  run failed: command  exited (1)
```

## 5. CLI smoke (--version, --help)

```
0.14.1
---
Usage: brainstorm [options] [command]

AI coding assistant with intelligent model routing

Options:
  -V, --version                        output the version number
  -h, --help                           display help for command

Commands:
  init [options]                       Initialize project for AI-assisted
                                       development
  harness                              Business harness: init / lint / reindex /
                                       verify / query / summary
  eval [options]                       Run capability evaluation probes against
                                       a model
```

## 6. BR upstream health (live)

````
{"status":"ok","db":true,"redis":true,"uptime":7235,"version":"1.0.0-beta.1"}```

## 7. npm registry — published 0.14.1 packages
````

@brainst0rm/cli @ 0.14.1
@brainst0rm/core @ 0.14.1
@brainst0rm/db @ 0.14.1
@brainst0rm/providers @ 0.14.1
@brainst0rm/router @ 0.14.1
@brainst0rm/tools @ 0.14.1
@brainst0rm/shared @ 0.14.1
@brainst0rm/workflow @ 0.14.1
@brainst0rm/gateway @ 0.14.1
@brainst0rm/agents @ 0.14.1
@brainst0rm/godmode @

```

## 8. source/test inventory
```

package count: 44
source files: 611
test files: 199
source LOC: 113688 total
test LOC: 44941 total

```

## 9. docs surface
```

total docs: 59
runbooks: 7
assessment artifacts: 7
docs total LOC: 16862 total

```

## 10. CI workflows
```

ai-review.yml
br-contract.yml
ci.yml
codeql.yml
e2e.yml
fresh-install.yml
npm-publish.yml
release.yml
rollback-drill.yml

```

## 11. v0.14.1 tag points to
```

tag v0.14.1
Tagger: Brainstorm <justinjilg@users.noreply.github.com>
Date: Sat May 16 03:27:46 2026 -0700

Release v0.14.1

commit b303a03206692ae6b7b1cc29d1a2598feb8b1168
Author: Brainstorm <1328891+justinjilg@users.noreply.github.com>

```

## 12. BR drift ratchet — last run
```

{"conclusion":"success","createdAt":"2026-05-16T10:27:08Z","status":"completed"}

```

## 13. PRs merged this session
```

521
commits between v0.13.0 and HEAD

```

## 14. routing_audit table existence (sanity)
```

```

## 15. P2b envelope→audit wiring presence
```

7291: const { RoutingAuditRepository, wireRoutingAudit } =
7293: const auditRepo = new RoutingAuditRepository(db);
7294: const onEnvelope = wireRoutingAudit(auditRepo);

```

## 16. P9d-2 chaos test count
```

9

```

## 17. P8d downgrade guard presence
```

109:export function assertNoUnknownMigrations(
158: assertNoUnknownMigrations(db, knownNames);

```

## 18. precommit autoregen
```

-rwxr-xr-x 1 justin staff 608 May 16 02:45 scripts/precommit-regen-catalog.sh

```

## 19. v15 audit baseline (prior round, on disk)
```

# Stochastic Assessment Audit v15 — 2026-05-15 (harness rubric)

11th Agent: Calibration & Bias Auditor.
Output verbatim per Phase 4 of `/stochastic-assessment` skill.

## Scores

- **Calibration: 6.5 / 10**
- **Honesty: 6.5 / 10**
- **Profile-migration legitimacy: PARTIAL**

Both below the 7-floor → score overrides applied per monotonicity invariant.
Synthesis retained because honesty findings are minor (math drift on
per-agent overall column, undisclosed missing-input-files problem). The
key structural issue: the rubric file + evidence file were drafted in
this session but had NOT been committed when the auditor ran. Auditor
correctly flagged that an external observer cannot verify the harness
migration without the on-disk rubric. Fixed in this commit (audit is
now committed alongside rubric + evidence).

```

## 20. CI on main — last 3 runs
```

Rollback Drill completed failure
BR Contract Ratchet completed success
CodeQL Security Analysis completed success
Release (Changesets) completed failure
CI completed success

```

```
