# Runbook: Audit Chain Broken or Discontinuous

**Symptoms:**

- `storm dashboard` (if envelope panel is wired) shows a missing or
  zero-length `x-br-audit-hash` in the routing log
- Trajectory submission to `/v1/agent/trajectory` returns 200 but BR's
  evidence ledger query reports no matching chain pointer for the
  request
- `SELECT * FROM routing_audit WHERE audit_hash IS NULL` returns rows
  with `actual_cost_usd IS NOT NULL` (route was charged but the chain
  pointer wasn't captured)
- BR audit-chain verification command reports "chain discontinuous at
  request_id X" or "audit_hash missing from upstream ledger"

## Scope note

The audit chain is BR's evidence-ledger pointer (`x-br-audit-hash`)
captured per-turn by the CLI's envelope listener and persisted to the
`routing_audit` SQLite table (migration 034). A broken chain means
EITHER:

1. **Capture-side break**: BR emitted the hash but the CLI didn't
   record it (envelope listener not invoked, or insert() failed).
2. **Upstream-side break**: BR emitted a hash that doesn't correspond
   to a real evidence-ledger entry (BR bug; rare).
3. **Verification-side break**: The chain is intact but the consumer
   (e.g. trajectory submission, dashboard query) is reading from the
   wrong place.

Most breaks are class 1.

## Quick verification (60s)

```bash
# 1. Is the routing_audit table populated?
sqlite3 ~/.brainstorm/brainstorm.db \
  "SELECT COUNT(*), COUNT(audit_hash), MIN(captured_at), MAX(captured_at) FROM routing_audit"
# Expected: <count> entries, all with non-null audit_hash, recent timestamps.
# Bad: count is 0 → envelope listener never fired (capture-side break).
# Bad: count > 0 but audit_hash count is 0 → listener fired but hash field
#      not populated (parser bug or BR returned empty hash header).

# 2. Recent envelope captures (manual probe via curl)
KEY="${BRAINSTORM_API_KEY:-br_live_b028d73791f9a2d614acafe80b89d36f66e69d3091d9b70b24658ccc03a5a48a}"
curl -sS -D - -o /dev/null --max-time 20 \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -X POST https://api.brainstormrouter.com/v1/chat/completions \
  -d '{"model":"auto","messages":[{"role":"user","content":"x"}],"max_tokens":1}' \
  | grep -i "^x-br-audit-hash"
# Expected: x-br-audit-hash: <64-hex-string>
# Bad: header missing → BR didn't emit (upstream bug; rare)
# Bad: header present but value empty → BR upstream issue

# 3. Verify ordering of recent captures (consecutive ones should NOT
#    have identical hashes — that would be a chain collapse)
sqlite3 ~/.brainstorm/brainstorm.db \
  "SELECT request_id, audit_hash FROM routing_audit ORDER BY captured_at DESC LIMIT 10"
```

## Recovery paths

### Class 1a: routing_audit table is empty

The envelope listener didn't fire OR didn't insert. Until P2b wires the
listener → repository, this is EXPECTED behavior — the table exists
(migration 034) but no writer is wired. After P2b lands:

- Verify `createBrainstormSaaSProvider` was called with `{ onEnvelope }`
  (grep `packages/cli/src/init` or wherever the registry constructs
  the provider).
- Confirm `BrEnvelopeListener` calls `RoutingAuditRepository.insert()`.
- Run a chat turn, check the table immediately after.

### Class 1b: audit_hash field is null for some rows

Parser regression or BR returned an empty header. Inspect:

```bash
sqlite3 ~/.brainstorm/brainstorm.db \
  "SELECT request_id, audit_hash, br_build, captured_at \
   FROM routing_audit WHERE audit_hash IS NULL ORDER BY captured_at DESC LIMIT 5"
```

If `br_build` is set but `audit_hash` is null, BR responded without the
header. Could be a BR-side fallback path. Pre-P2b: this can't happen
because nothing writes. Post-P2b: file a BR-side bug if it persists.

### Class 2: BR ledger has no matching entry

Rare; means BR emitted a hash but didn't persist its own ledger entry.
Capture the request_id + audit_hash and report to BR via
`/v1/governance/completion-audit` query:

```bash
sqlite3 ~/.brainstorm/brainstorm.db \
  "SELECT request_id, audit_hash FROM routing_audit ORDER BY captured_at DESC LIMIT 1" \
  | tee /tmp/audit-pair.txt

# Query BR's audit ledger for this hash
curl -sS -H "Authorization: Bearer $BRAINSTORM_API_KEY" \
  "https://api.brainstormrouter.com/v1/governance/completion-audit?audit_hash=$(awk '{print $2}' /tmp/audit-pair.txt)"
# If empty: BR upstream ledger break. Escalate to BR ops.
```

### Class 3: Consumer reading wrong location

Some consumer (trajectory submission, third-party audit tool, dashboard
query) might be reading from a stale path. Verify against the canonical
column names in `packages/db/src/routing-audit-repository.ts`:
`audit_hash` (snake) on the table, `auditHash` (camel) on the typed
row. Cross-reference your consumer's query/access pattern.

## What this runbook does not cover

- The cryptographic verification of `audit_hash` against BR's signing
  key (that lives in BR-side audit tooling).
- Recovery from a corrupted SQLite — see vault-recovery.md for the
  related "DB corrupt" path; same WAL checkpoint + backup-restore
  applies.
- The P2b wiring itself — that's a code change, not an operator
  recovery action. See PR queue for the path-to-90 plan.

## Carry-forward

This runbook will be referenced by the doctor-runbook router (P8a)
once a doctor check exists that detects audit-chain discontinuity.
Until then, this runbook is reachable via `storm doctor` failures
that mention "audit" or "chain" in the detail text (routes to
startup-health.md by default — TODO: add `audit-chain-broken.md`
to the keyword routing in `packages/cli/src/logic/doctor-runbook.ts`).
