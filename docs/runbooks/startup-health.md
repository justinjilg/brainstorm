# Runbook: Startup and Health Verification

## Symptoms

- CLI fails to start
- `brainstorm status` returns errors
- Desktop app shows "disconnected" in status rail

## Verification Steps

### 1. Check CLI binary

```bash
node packages/cli/dist/brainstorm.js --version
# Expected: version number (e.g., 0.14.0)
```

### 2. Check database

```bash
ls ~/.brainstorm/brainstorm.db
# Expected: file exists, >0 bytes
# If missing: CLI will auto-create on first run
```

### 3. Check provider connectivity

```bash
node packages/cli/dist/brainstorm.js models
# Expected: list of available models from configured providers
# If empty: check API keys (see api-key-rotation.md)
```

### 4. Check vault

```bash
node packages/cli/dist/brainstorm.js config
# Look for: vault status (locked/unlocked)
# If locked: vault will prompt for password on first use
```

### 5. Check memory directory

```bash
ls ~/.brainstorm/projects/
# Expected: hash-named directories for each project you've worked in
```

### 6. Health endpoint (server mode)

```bash
curl http://localhost:3141/health
# Expected: {"status": "ok", "version": "..."}
# If no response: server not running. Start with `brainstorm serve`
```

## Common Failures

| Symptom                  | Cause                              | Fix                                                       |
| ------------------------ | ---------------------------------- | --------------------------------------------------------- |
| "Cannot find module"     | Build artifacts stale              | `npx turbo run build --force`                             |
| "SQLITE_CANTOPEN"        | DB path permissions                | Check `~/.brainstorm/` ownership                          |
| "No providers available" | Missing API keys                   | Run `brainstorm config` to check, see api-key-rotation.md |
| Server refuses to start  | Missing jwtSecret on non-localhost | Set `BRAINSTORM_JWT_SECRET` env var                       |

## Monitoring Link

- Monitor: `brainstorm-cli-health` in `docs/internal/monitoring-manifest.json`
