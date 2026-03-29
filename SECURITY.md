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

- API keys are encrypted at rest using **AES-256-GCM** with **Argon2id** key derivation
- Vault stored at `~/.brainstorm/vault.enc`
- Optional 1Password bridge reads from vault "Dev Keys" via `op read`
- Key resolver chain: local vault → 1Password → environment variables

### Shell Execution

- Three sandbox modes: `none`, `restricted` (default), `container` (Docker)
- Restricted mode blocks dangerous patterns (rm -rf /, curl | sh, etc.)
- Container mode runs all shell commands in an isolated Docker container
- Tool permission system: `auto`, `confirm`, `plan` modes

### Agent Security

- 10 middleware in the security pipeline, including post-write credential scanning
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
