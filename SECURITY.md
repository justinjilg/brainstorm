# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Brainstorm, please report it responsibly.

**Email:** security@brainstorm.co

**Do NOT open a public GitHub issue for security vulnerabilities.**

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response timeline

- **Acknowledgment:** Within 48 hours
- **Assessment:** Within 1 week
- **Fix:** Critical vulnerabilities patched within 2 weeks

## Security Architecture

Brainstorm handles sensitive data (API keys, code, shell access) and takes security seriously:

### Key Storage

- API keys encrypted at rest using **AES-256-GCM** with **Argon2id** key derivation (64MB memory, 3 iterations, parallelism 4 — meets OWASP interactive-login recommendation)
- Plaintext key ring buffers zeroed immediately after encryption/decryption (prevents memory residency)
- Vault stored at `~/.brainstorm/vault.enc` with 0o600 permissions
- Auto-lock with configurable timeout; re-prompts for password after timeout
- 1Password bridge with 60-second failure TTL (self-heals from transient errors)
- Key resolver chain: local vault → 1Password → environment variables

### Shell Execution

- Three sandbox modes: `none`, `restricted` (default), `container` (Docker)
- Restricted mode blocks dangerous patterns (rm -rf /, curl | sh, fork bombs, etc.)
- Sandbox enforced on both `shell` and `process_spawn` tools
- Container mode uses per-invocation sentinel UUIDs for exit code isolation
- Background process limits enforced before spawn; orphans killed on eviction
- Tool permission system: `auto`, `confirm`, `plan` modes

### File Safety

- Path traversal protection on all file tools (read, write, edit, multi-edit, batch-edit)
- Blocked system paths: /etc, /usr, /var, /proc, /sys, /dev, /sbin, /boot
- Atomic writes (tmp-file-then-rename) on file_write and multi_edit
- Checkpoint snapshots before every write for undo capability

### Agent Security

- 11 middleware in the security pipeline, including post-write credential scanning
- 19 regex patterns detect leaked secrets in file writes
- Subagent isolation: `none`, `git-stash`, `docker`
- Permission levels per tool (read, write, execute, admin)

### Network

- All BrainstormRouter communication over HTTPS
- API keys transmitted as Bearer tokens, never in URLs
- MCP OAuth with client_credentials flow

## Supported Versions

| Version        | Supported   |
| -------------- | ----------- |
| Latest (main)  | Yes         |
| Older releases | Best effort |

## Scope

The following are in scope for security reports:

- Vault encryption weaknesses
- Shell sandbox escapes
- API key leaks (in logs, error messages, tool outputs)
- Permission bypass (tool executing without approval)
- Credential scanning bypass (secrets written to files undetected)
- MCP OAuth token handling
- Dependency vulnerabilities with exploitable paths

Out of scope:

- Issues requiring physical access to the machine
- Social engineering
- Denial of service against local CLI
- Vulnerabilities in upstream dependencies with no exploitable path
