# Runbook: Rollback Published Brainstorm CLI Version

**Symptoms / triggers:**

- A newly-published `@brainst0rm/cli` version breaks operator workflows
- Critical bug found post-publish that affects every operator on the
  new version
- Compliance / governance demand: revert to a known-good version
- The `rollback-drill.yml` weekly cron failed, indicating the
  forward+back path is broken

## Scope

This runbook covers **client-side version rollback** (downgrading an
operator's globally-installed CLI to a previous npm version). It does
NOT cover BR-side rollback or CLI-managed-state migrations (vault,
SQLite schemas) — those are separate concerns; see Carry-forward.

## Operator-facing rollback (single machine)

```bash
# 1. Identify currently-installed version
brainstorm --version
# Expected: e.g. "0.14.0"

# 2. List published versions (most recent first)
npm view @brainst0rm/cli versions --json | jq '.[-5:]'
# Expected: ["0.13.0", "0.14.0", ...]

# 3. Downgrade to a specific previous version
npm install -g @brainst0rm/cli@0.13.0
brainstorm --version
# Expected: "0.13.0"

# 4. Smoke-test the downgrade
brainstorm doctor
brainstorm models
# Expected: both exit 0 (warnings OK; stack traces NOT OK)
```

If the downgrade itself fails (E404 / postinstall error / etc.),
this is the failure class the `rollback-drill.yml` workflow exists to
catch. Check the most recent run:

```bash
gh run list --workflow=rollback-drill.yml --limit 5
# If the most-recent scheduled run is RED, the rollback path itself
# is broken — escalate before more operators hit it.
```

## Fleet-wide rollback (npm dist-tag deprecation)

If a published version is bad and you need to point EVERYONE'S
`npm install -g @brainst0rm/cli` (no `@version`) at a previous version:

```bash
# 1. Confirm you have publish access
npm whoami
# Expected: account with rights to @brainst0rm scope

# 2. Move the 'latest' tag back to the previous version
npm dist-tag add @brainst0rm/cli@0.13.0 latest

# 3. Confirm
npm view @brainst0rm/cli dist-tags
# Expected: latest: 0.13.0 (no longer 0.14.0)

# 4. (Optional) Deprecate the broken version with a message so
#    `npm install` shows operators the warning
npm deprecate @brainst0rm/cli@0.14.0 \
  "Broken release — rolled back to 0.13.0. Run: npm install -g @brainst0rm/cli@0.13.0"
```

After step 2, new `npm install -g @brainst0rm/cli` calls resolve to
0.13.0. Existing operators on 0.14.0 are NOT automatically downgraded
— they need to run `npm install -g @brainst0rm/cli` again (which now
resolves the new 'latest').

## Verification post-rollback

```bash
# Re-publish a patch with the fix (NOT a re-version of the broken one)
npm publish ...  # 0.14.1, NOT 0.14.0

# Or, if the fix takes time:
# Confirm the deprecate warning shows up
npm install -g @brainst0rm/cli@0.14.0
# Expected output includes: "npm WARN deprecated @brainst0rm/cli@0.14.0: ..."
```

## CLI-managed state compatibility

This runbook covers PACKAGE rollback. CLI-managed state on disk may
NOT downgrade cleanly:

- **Vault** (`~/.brainstorm/vault.json` or equivalent): the vault
  file format is captured by the published version. If a newer
  version changed the format and the operator downgrades, the
  vault may fail to unlock. Tested at vault-recovery.md.
- **SQLite DB** (`~/.brainstorm/brainstorm.db`): migrations are
  forward-only by default. Migration 034 (routing_audit) added by
  the v0.14.x line cannot be auto-rolled-back. Operator can:
  - Keep the v0.14.x DB and ignore the unused routing_audit table
    (safe; the table just sits empty)
  - Back up + delete `~/.brainstorm/brainstorm.db` to start fresh
    on the downgraded version (loses session history)
  - Manually `DROP TABLE routing_audit` (advanced; only if you
    understand the schema)
- **Agent identity** (`~/.brainstorm/agent.json`): forward-compatible
  format; downgrade-safe.
- **Config** (`~/.brainstorm/config.toml`): pre-existing fields
  preserved across downgrade; new fields may show as "unknown" and
  be ignored.

## Escalation

- If npm publish is unavailable / requires more access: file an
  internal request to whoever holds publish rights to `@brainst0rm`.
- If a security-critical bug is in 0.14.0 and operators need to
  upgrade despite a state-format break: ship 0.14.1 with the fix
  AND state-migration logic, NOT a rollback.

## Carry-forward

- **State rollback (P8d)**: automated downgrade path for vault +
  SQLite migrations. Not yet implemented; this runbook documents
  the manual path until P8d ships.
- **rollback-drill.yml extension**: add a state-rollback step that
  installs 0.14.x, creates state, downgrades to 0.13.x, verifies
  state still readable. Currently the drill only verifies the
  package-install path.

## References

- `scripts/rollback-drill.sh` — the CI rollback drill script
- `.github/workflows/rollback-drill.yml` — weekly cron + on-push
- `docs/runbooks/vault-recovery.md` — vault-specific recovery
- `docs/runbooks/audit-chain-broken.md` — routing_audit downgrade
  implications
