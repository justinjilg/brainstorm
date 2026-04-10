# Runbook: Vault Unlock Failure Recovery

## Symptoms

- "Vault locked" error during chat/daemon operations
- Provider API calls fail with "No API key available"
- `brainstorm config` shows vault status: locked

## Background

The vault uses AES-256-GCM encryption with Argon2id key derivation. Keys are stored in `~/.brainstorm/vault.enc`. The resolver chain is: local vault -> 1Password CLI -> environment variables.

## Recovery Steps

### 1. Check 1Password bridge (preferred path)

```bash
# Verify 1Password CLI is authenticated
op whoami
# Expected: account info

# Test key retrieval
op read "op://Dev Keys/ANTHROPIC_API_KEY/credential" | head -c 10
# Expected: first 10 chars of key
```

If 1Password fails:

```bash
# Re-authenticate
op signin
```

### 2. Check environment variable fallback

```bash
# Verify critical env vars are set
echo $ANTHROPIC_API_KEY | head -c 5
echo $OPENAI_API_KEY | head -c 5
# Expected: first 5 chars of each key

# If missing, load from zshrc
source ~/.zshrc
```

### 3. Reset local vault (last resort)

```bash
# Back up current vault
cp ~/.brainstorm/vault.enc ~/.brainstorm/vault.enc.bak

# Delete vault — will be recreated on next use
rm ~/.brainstorm/vault.enc

# Re-run setup to re-populate
brainstorm setup
```

### 4. Verify recovery

```bash
brainstorm models
# Expected: models listed from at least one provider
```

## Common Failures

| Symptom                                  | Cause                       | Fix                                   |
| ---------------------------------------- | --------------------------- | ------------------------------------- |
| "Argon2id failed"                        | Corrupted vault file        | Delete and recreate (step 3)          |
| "op: not found"                          | 1Password CLI not installed | `brew install --cask 1password-cli`   |
| "OP_SERVICE_ACCOUNT_TOKEN not set"       | Missing env var             | Check `~/.zshrc` for token loading    |
| Keys work in shell but not in brainstorm | Shell env not inherited     | Restart terminal or `source ~/.zshrc` |

## Prevention

- The vault auto-locks after 30 minutes of inactivity
- The 1Password bridge caches keys for 5 minutes (TTL)
- Environment variables are the final fallback — always have them configured
