# v17 evidence — 2026-05-16 (post v16 follow-ups + v0.14.3 publish)

## 1. git log (last 20 commits)

b62141f fix(tools): widen result type in atomicity test — typecheck green (#336)
10e9a53 chore: bump to 0.14.3 + add repository field to all 16 unpublished packages (#335)
94d8600 chore: bump to 0.14.2 — clean publish all 43 workspaces (#333)
0ec7efc fix(v16): close 3 remaining findings (drift hole, retention, edit atomicity) (#334)
be687bd fix(security): close 3 v16 Attacker findings — D6 lift (#332)
f783f1c docs(assessment): v16 stochastic round — 6.94 (Δ +0.24) (#331)
488c9ec fix(ci): auto-discover publishable workspaces (closes v16 D10 -0.45) (#330)
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

## 2. build (full workspace, no exclusions)

```
@brainst0rm/cli:build: DTS dist/index.d.ts 47.00 B

 Tasks:    45 successful, 45 total
Cached:    36 cached, 45 total
  Time:    5.421s

```

## 3. typecheck

```

 Tasks:    75 successful, 75 total
Cached:    42 cached, 75 total
  Time:    8.497s

```

## 4. test summary (all except desktop)

```
@brainst0rm/core:test:  Test Files  35 passed (35)
@brainst0rm/core:test:       Tests  435 passed (435)
@brainst0rm/core:test:    Start at  04:51:08
@brainst0rm/core:test:    Duration  13.17s (transform 2.69s, setup 0ms, collect 25.96s, tests 31.64s, environment 9ms, prepare 4.89s)
@brainst0rm/core:test:

 Tasks:    89 successful, 89 total
Cached:    80 cached, 89 total
  Time:    13.821s

```

## 5. CLI smoke

```
0.14.3
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
{"status":"ok","db":true,"redis":true,"uptime":3094,"version":"1.0.0-beta.1"}```

## 7. npm registry — published 0.14.3 sweep
````

@brainst0rm/cli @ 0.14.3
@brainst0rm/core @ 0.14.3
@brainst0rm/db @ 0.14.3
@brainst0rm/providers @ 0.14.3
@brainst0rm/router @ 0.14.3
@brainst0rm/tools @ 0.14.3
@brainst0rm/shared @ 0.14.3
@brainst0rm/workflow @ 0.14.3
@brainst0rm/gateway @ 0.14.3
@brainst0rm/agents @ 0.14.3
@brainst0rm/godmode @ 0.14.3
@brainst0rm/server @ 0.14.3
@brainst0rm/onboard @ 0.14.3
@brainst0rm/code-graph @ 0.14.3
@brainst0rm/harness-fs @ 0.14.3
@brainst0rm/harness-index @ 0.14.3
@brainst0rm/archetype-msp @ 0.14.3
@brainst0rm/archetype-saas-platform @ 0.14.3
@brainst0rm/broker @ 0.14.3
@brainst0rm/docgen @ 0.14.3
@brainst0rm/eval @ 0.14.3
@brainst0rm/gateway @ 0.14.3
@brainst0rm/hooks @ 0.14.3
@brainst0rm/ingest @ 0.14.3
@brainst0rm/mcp @ 0.14.3
@brainst0rm/orchestrator @ 0.14.3
@brainst0rm/plugin-sdk @ 0.14.3
@brainst0rm/projects @ 0.14.3
@brainst0rm/scheduler @ 0.14.3
@brainst0rm/sdk @ 0.14.3
@brainst0rm/vault @ 0.14.3
@brainst0rm/vscode @ 0.14.3

```

## 8. v0.14.3 publish workflow
```

{"conclusion":"success","createdAt":"2026-05-16T11:42:30Z","status":"completed"}

```

## 9. source/test inventory
```

package count: 44
source files: 611
test files: 200
source LOC: 113932 total
test LOC: 45221 total

```

## 10. docs surface
```

total docs: 62
runbooks: 7
assessment artifacts: 10

```

## 11. CI workflows + recent runs on main
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

---

CI in_progress
Fresh-Environment Install Verification in_progress
Release (Changesets) in_progress
Rollback Drill in_progress
CodeQL Security Analysis in_progress
BR Contract Ratchet in_progress
Rollback Drill completed failure
BR Contract Ratchet completed success

```

## 12. v0.14.3 tag
```

tag v0.14.3
Tagger: Brainstorm <justinjilg@users.noreply.github.com>
Date: Sat May 16 04:42:20 2026 -0700

Release v0.14.3 — fix sigstore repository field + complete publish

commit 10e9a5392bcf59b26446ef84a942d5b89cecc491
Author: Brainstorm <1328891+justinjilg@users.noreply.github.com>

```

## 13. v16 fixes landed this session — verification
```

Auto-discover publish workflow:
npm publish --workspaces --provenance --access public

Attacker fix 1 (server dev token, packages/server/src/server.ts):
110: private devTokenPath: string | null = null;
135: private initDevToken(): void {
145: this.devTokenPath = tokenPath;
149: private verifyDevToken(authHeader: string | undefined): boolean {
179: this.initDevToken();

Attacker fix 2 (kill-gate flag-loader extensions):
14
^ count of new EOF-or-ws-anchored DANGER_PATTERNS entries

Attacker fix 3 (platform event dedupe):
92:const seenEventIds = new Map<string, number>();
98: seenEventIds.clear();
101:function checkAndRecordEventId(eventId: string, now: number): boolean {
107: for (const [id, ts] of seenEventIds) {
108: if (ts < cutoff) seenEventIds.delete(id);

Architect retention (routing_audit cleanup):
packages/db/src/client.ts:83: ["routing_audit", "DELETE FROM routing_audit WHERE captured_at < ?"],
packages/db/src/client.ts:904: CREATE INDEX IF NOT EXISTS idx_routing_audit_captured_at
packages/db/src/client.ts:905: ON routing_audit(captured_at);
packages/db/src/routing-audit-repository.ts:195: .prepare("SELECT \* FROM routing_audit ORDER BY captured_at DESC LIMIT ?")
packages/db/src/routing-audit-repository.ts:235: deleteOlderThan(cutoffUnixSec: number): number {

Sr Engineer drift hole (mapped type):
33:const ALL_BR_ENVELOPE_FIELDS_MAP: Required<Record<keyof BrEnvelopeLike, true>> =
78: ALL_BR_ENVELOPE_FIELDS_MAP,

Chaos Monkey edit atomicity:
9: fsyncSync,
33:function atomicReplaceFile(path: string, content: string): void {
42: fsyncSync(fd);

```

## 14. v16 audit baseline (prior round)
```

# Stochastic Assessment Audit v16 — 2026-05-16 (harness rubric)

11th Agent: Calibration & Bias Auditor.
Output verbatim per Phase 4 of `/stochastic-assessment` skill.

## Scores

- **Calibration: 8.0 / 10**
  ...
  Calibration 8.0 ≥ 7.0 floor. Honesty 8.5 ≥ 7.0 floor. Two dimension

```

```
