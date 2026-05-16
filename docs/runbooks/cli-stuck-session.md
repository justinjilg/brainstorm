# Runbook: CLI Session Stuck or Unresponsive

**Symptoms:**

- `storm chat` shows a streaming spinner that never advances
- Keystroke input ignored; Ctrl-C does nothing or takes >10s
- TUI tabs (Esc / 1-4) don't switch
- New `storm` invocation hangs at boot
- `~/.brainstorm/brainstorm.db` open by a stale process

## Quick verification (30s)

```bash
# Is there a stuck storm process?
ps aux | grep -E "storm|brainstorm" | grep -v grep

# Is the SQLite DB locked?
lsof ~/.brainstorm/brainstorm.db 2>/dev/null

# Recent activity in the vault dir?
ls -la ~/.brainstorm/*.lock ~/.brainstorm/.curator-* 2>/dev/null
```

## Recovery paths

### 1. Mid-stream hang during chat (most common)

The agent loop is waiting on BR's streaming response. Options:

- **Wait 30s**. BR auto-aborts requests after the default timeout
  (see `x-br-total-latency-ms` for the per-request cap).
- **Ctrl-C twice.** First Ctrl-C signals abort; the second forces exit.
  Pre-P9d-chaos, the abort path is tested in
  `apps/desktop/tests-live/abort.live.spec.ts` and is reliable.
- **Kill the process group:**

  ```bash
  pkill -INT -f "node.*brainstorm"   # Try graceful first
  sleep 5
  pkill -KILL -f "node.*brainstorm"  # Force if still stuck
  ```

### 2. Boot hang (storm just-launched doesn't respond)

The CLI is doing one of: vault unlock, gateway discovery, model probe,
or DB migration. Diagnose:

```bash
# Run with verbose tracing
BRAINSTORM_LOG=debug storm chat 2>&1 | head -40

# Or run doctor first — it tests the same boot path explicitly
storm doctor
```

Common causes:

- **Vault unlock prompt invisible.** If you set `BRAINSTORM_VAULT_PASSWORD`
  in env vs entering it interactively, a mismatch can hang the prompt.
  See `docs/runbooks/vault-recovery.md`.
- **BR discovery timeout.** Network slow or BR degraded. See
  `docs/runbooks/br-degraded.md`.
- **SQLite migration blocked.** A long-running migration on an
  upgrade. Check:

  ```bash
  sqlite3 ~/.brainstorm/brainstorm.db ".tables" | wc -l
  # Expected: ~30 tables on current schema (v34 routing_audit). If frozen
  # at boot, the migration is mid-flight — wait or restart with --no-cache.
  ```

### 3. Stale lock files

If a previous `storm` crashed mid-write, lock files can persist:

```bash
# Curator lock (memory-curator subagent)
cat ~/.brainstorm/memory/.curator-lock 2>/dev/null
# Shows {"pid":N,"acquiredAt":...}; if that PID is dead, it's stale.

ps -p $(jq -r .pid < ~/.brainstorm/memory/.curator-lock) 2>/dev/null
# No output → process is dead, lock is stale

# Manual cleanup (POST-P9c only — pre-P9c, releaseLock would also unlink
# active locks; do this only when you're sure no storm is running)
rm -f ~/.brainstorm/memory/.curator-lock
rm -f ~/.brainstorm/dream-lock
```

### 4. SQLite "database is locked" errors

WAL mode + busy_timeout=5s usually prevents this. If you see it:

```bash
# Stop all storm processes first
pkill -f "node.*brainstorm" 2>/dev/null

# Verify no holder remains
lsof ~/.brainstorm/brainstorm.db
# Should print nothing

# If a stale WAL is present, checkpoint it
sqlite3 ~/.brainstorm/brainstorm.db "PRAGMA wal_checkpoint(TRUNCATE);"
```

## Diagnostic data to capture before escalating

When opening an issue or asking for help:

```bash
# 1. CLI version + env
storm --version
node --version
echo "OS: $(uname -a)"

# 2. doctor output
storm doctor 2>&1 | head -50

# 3. recent storm processes
ps -eo pid,etime,command | grep -E "storm|brainstorm" | grep -v grep

# 4. DB state
ls -la ~/.brainstorm/brainstorm.db*

# 5. recent log tail (if BRAINSTORM_LOG was set)
tail -200 ~/.brainstorm/storm.log 2>/dev/null
```

## What this runbook does not cover

- Chat-content-specific issues (model returning loops, etc.) — those
  are upstream model behaviour, not CLI state.
- Desktop app hangs — see `apps/desktop/tests-live/AUDIT.md` for the
  desktop-specific recovery path.
