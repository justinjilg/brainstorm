# Runbook: API Key Rotation

## When to Rotate

- Suspected key compromise
- Regular rotation schedule (quarterly recommended)
- Employee offboarding
- Provider security advisory

## Key Inventory

All keys are stored in 1Password vault "Dev Keys". Check the full registry at `~/Projects/resources/secrets-registry.md`.

| Key              | Provider    | 1Password Item                 | Env Var                        |
| ---------------- | ----------- | ------------------------------ | ------------------------------ |
| Anthropic API    | Anthropic   | `ANTHROPIC_API_KEY`            | `ANTHROPIC_API_KEY`            |
| OpenAI API       | OpenAI      | `OPENAI_API_KEY`               | `OPENAI_API_KEY`               |
| Google AI        | Google      | `GOOGLE_GENERATIVE_AI_API_KEY` | `GOOGLE_GENERATIVE_AI_API_KEY` |
| BrainstormRouter | Self-hosted | `BRAINSTORM_API_KEY`           | `BRAINSTORM_API_KEY`           |

## Rotation Steps

### 1. Generate new key at provider

- Anthropic: https://console.anthropic.com/settings/keys
- OpenAI: https://platform.openai.com/api-keys
- Google: https://aistudio.google.com/apikey

### 2. Update 1Password

```bash
# Example for Anthropic
op item edit "ANTHROPIC_API_KEY" "credential=sk-ant-NEW_KEY_HERE" --vault "Dev Keys"
```

### 3. Update shell environment

```bash
# The _op_read helper in ~/.zshrc auto-pulls from 1Password
# Restart terminal or source to pick up new key
source ~/.zshrc

# Verify
echo $ANTHROPIC_API_KEY | head -c 10
```

### 4. Clear local vault cache

```bash
# Force vault to re-pull from 1Password on next access
rm ~/.brainstorm/vault.enc
```

### 5. Verify new key works

```bash
brainstorm models
# Expected: models from the rotated provider appear in the list

# Quick test
brainstorm run "say hello" --model anthropic/claude-sonnet-4.6
# Expected: response without auth errors
```

### 6. Revoke old key at provider

Only after verifying the new key works.

## Emergency: Compromised Key

```bash
# 1. Immediately revoke at provider console
# 2. Update 1Password
op item edit "ANTHROPIC_API_KEY" "credential=REVOKED" --vault "Dev Keys"
# 3. Rotate as above
# 4. Check BrainstormRouter logs for unauthorized usage
```

## BrainstormRouter Key (self-hosted)

The BrainstormRouter API key authenticates the CLI to the gateway at `api.brainstormrouter.com`. Rotation requires updating both the client key and the server's accepted keys list.
