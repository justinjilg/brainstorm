# @brainst0rm/vault

Encrypted API key storage with AES-256-GCM + Argon2id key derivation.

## Key Exports

- `VaultStore` — Encrypted CRUD for API keys
- `KeyResolver` — Resolution chain: vault → 1Password → environment variables

## Usage

```bash
storm vault add BRAINSTORM_API_KEY    # Encrypt and store a key
storm vault list                       # List stored keys
storm vault status                     # Health check
```

Keys are stored in `~/.brainstorm/vault.enc` and encrypted at rest. The vault auto-locks after inactivity.
