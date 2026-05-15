# Changelog

## [Unreleased] — 2026-05-15 — Path-to-90 v14: BR integration refresh

Stochastic assessment v14 promoted baseline from 6.102 (v13) to **6.122 / 10**
after 11th-auditor calibration. Goal: every dimension ≥ 9.0 ("above 90"). No
new features in this window — every PR is quality/security/wiring/test/docs
work toward the threshold. Full assessment in `docs/assessment-{evidence,
synthesis,audit}.md`; remediation plan in `docs/path-to-90-plan-2026-05-15.md`.

### Assessment infrastructure

- v14 stochastic assessment (10 agents + 11th auditor): baseline 6.122 / 10
  (+0.020 over v13). Calibration audit ruled 8 of 10 LOWER cites were
  newly-enumerated chronic conditions, not v14 regressions — class-2
  override applied per monotonicity invariant.
- Path-to-90 plan: 11 phases (P1–P11) with per-dimension lift estimates,
  decision-gate annotations for structurally-bounded dims (D4 Production
  Evidence, D9 Scale Readiness, D10 Ship Readiness partial), and sequencing.

### BR integration

- **Drift cleanup** (PR #302): `br_health` `/v1/health` → `/health` (auth
  path mismatch); memory enum `semantic/episodic/procedural` →
  `human/system/project/general` (matches live `/v1/discovery`); trajectory
  POST path `/v1/agent/trajectories` → `/v1/agent/trajectory` (singular,
  matches OpenAPI); `BrOutcomeReporter` feature-flagged for the not-yet-
  public `/v1/agents/{id}/dispatch-outcomes` endpoint
  (`BR_DISPATCH_OUTCOMES_ENABLED=true` env override).
- **Envelope parser (P1a)** (PR #304): new `BrEnvelope` typed parser for
  BR's full `x-br-*` response envelope (now 37 canonical headers after
  P5's live-ratchet caught 4 cache-pathway headers missing from the v14
  evidence fixture). `createBrainstormSaaSProvider(apiKey, { onEnvelope })`
  fires a typed listener per response. Codex adversarial review passed:
  `complexityScore` type-aligned with `shared/TaskProfile`, async listener
  errors caught via fire-and-forget Promise chain, parser surface re-
  exported from package index.
- **Live BR contract ratchet (P5)** (PR #304): new
  `.github/workflows/br-contract.yml` runs the live drift-detection tests
  in `packages/providers/src/__tests__/br-live-contract.live.test.ts`
  against `api.brainstormrouter.com` on every PR + nightly cron. Asserts:
  envelope `unknownHeaders` empty; `/openapi.json` has ≥ 100 paths;
  `/v1/discovery` memory blocks match the CLI's hardcoded enum. On
  failure, comments on the PR with triage paths.
- **BR integration doc refresh** (PR #302):
  `docs/brainstormrouter-integration.md` rewritten — header table replaced
  with live 33-header envelope; model count 357+ → 31 (per
  `brainstormrouter.com/llms.txt`); MCP URL `/mcp/sse` (404) →
  `/v1/mcp/connect`; added discovery-surface block pointing at
  `/openapi.json`, `/v1/discovery`, `/llms.txt`, `/attestation`.

### Documentation (P6 — this entry)

- README package count: 27 → 44 (3 places: badge, architecture section,
  build command).
- CLAUDE.md package count: 27 → 44 (one place).
- `docs/br-capability-audit.md`: stale plural `/v1/agent/trajectories`
  references annotated as canonicalized to singular `/v1/agent/trajectory`
  in PR #302.

### Notes

- 44 packages on disk (was 27 documented). 17-package growth includes
  `harness-{crypto,drift,fs,index,loop}`, `dispatch-sdk`, `endpoint-stub`,
  `image-builder`, `msp-executor`, `parties`, `sandbox-{redteam,vz}`,
  `archetype-{msp,saas-platform}`, `server`, `vscode`, `code-graph`.
- 50+ CodeQL alerts cleared in the v14 window via PRs #294, #295, #297,
  #300, #301 (TOCTOU mkdtempSync fix, polynomial ReDoS caps, crypto
  governance polish).
- v13 Attacker bypasses still open and tracked as v15 carry-forward:
  `npx vitest-pwn` (word-boundary), `go test -exec=` (metachar regex
  gap), webhook nonce replay (eviction-window). Addressed in Phase 9.

## [v12.1] — 2026-03-29 — Security Hardening

### Security

- Vault: zero plaintext key ring buffers after encrypt/decrypt (memory residency fix)
- Vault: fix auto-lock silently falling through to env vars without re-prompting
- multi_edit: add path safety check (was missing — full filesystem write access)
- process_spawn: add sandbox enforcement (was bypassing restricted-mode guards)
- Docker sandbox: per-invocation sentinel UUID (prevents exit code spoofing)
- 1Password: 60s failure cache TTL (transient errors self-heal vs 30min stale)

### Fixed

- CI: remove continue-on-error on test step (was silencing all test failures)
- Gateway: extract shared HTTP helper (eliminates 40-line duplication)
- Hooks: add remove(id) method (register returned ID but removal was missing)
- MCP: url field optional in MCPServerConfig (matches Zod schema for stdio)
- Error.captureStackTrace in BrainstormError base class
- Telemetry test fixtures use valid enum values
- CLAUDE.md package count 16→20
- Thompson sampling: proper Gamma-ratio Beta sampler (Marsaglia-Tsang method)
- Soft budget limits: log warnings instead of silent no-op
- Scheduler: honest "failed" status when execution engine not wired
- Workflow: confidenceRetries reset per step (was leaking across steps)
- Review approval: rejection signals checked before approval signals
- Path guard: return symlink-resolved path (prevents TOCTOU swap)
- Ignore patterns: remove substring matching (was over-matching)
- Secret scanner: catch unquoted .env values
- Middleware pipeline: protected set prevents removal of security-scan
- Agent loop: apply middleware beforeAgent return value (was discarded)
- Trajectory capture: redact credentials, strip full path to basename
- Memory extraction: per-instance dedup set (was leaking across sessions)
- Trajectory reducer: fix inverted duplicate file-read detection
- Dead code removed: memory manager updateIndex()
- Subagent types: add missing "decompose" and "external"
- Loop detector: non-read/write tools no longer inflate read count
- PlanTree: move onSelect to useEffect (was mutating state during render)
- Voice recorder: replace require() with ESM import
- Vault get: mask secrets by default, require --reveal flag
- Vault password env: log warning when using BRAINSTORM_VAULT_PASSWORD

## [v12] — 2026-03-28 — Orchestration Engine

- 9-phase orchestration pipeline: `storm orchestrate pipeline`
- 11 built-in role agents (`.agent.md` format)
- Trajectory capture for BrainstormLLM v2 training
- Smart phase selection (33-78% cost savings)
- TUI Mode 5: Planning with collapsible tree visualization
- `storm intelligence` — BR intelligence report
- `storm projects` / `storm schedule` / `storm plan execute`
- Expert Persona Engine with model-specific tuning
- Agent memory tools (save, search, list, forget)
- Security scan middleware (19 credential detection patterns)
- 3 new packages: `@brainst0rm/projects`, `@brainst0rm/scheduler`, `@brainst0rm/orchestrator`
- Fix: TUI stability (abort timeout race, tool ID collisions, streaming re-renders)

## [v11] — 2026-02-15 — Claude Code Parity

- SelectPrompt (interactive arrow-key selection)
- Autocomplete (filtered slash command dropdown)
- `/context` (token breakdown with gauge), `/undo`, `/insights`
- Shortcut overlay (`?` in non-chat modes)
- Error categories with recovery suggestions

## [v10] — 2026-01-20 — DeerFlow Gaps

- Artifact persistence with manifests
- Temporal context injection
- Prose style learning from user patterns
- Test result parsing and display

## [v9] — 2026-01-08 — Build Wizard

- `/build` multi-model workflow wizard
- Per-step model assignment
- Cost estimation before execution
- 4 preset workflows

## [v8] — 2025-12-18 — BR Dashboard

- Dashboard mode with live BrainstormRouter data
- Model leaderboard, waste detection, guardian audit
- Budget forecast, 7-day cost trends

## [v7] — 2025-12-05 — Multi-Mode TUI

- 4-mode TUI: Chat / Dashboard / Models / Config
- Mode switching with Esc + number keys
- Provider-colored model names

## [v6] — 2025-11-20 — Role Workflows

- 5 roles: `/architect`, `/sr-developer`, `/jr-developer`, `/qa`, `/product-manager`
- One-command model + prompt + tools + output style configuration

## [v5] — 2025-11-10 — TUI Overhaul

- Streaming with spinners, syntax highlighting
- Tool tracking (status, duration), scrollable messages
- Catppuccin theme

## [v4] — 2025-10-25 — Foundation

- Semantic code search (TF-IDF), Docker sandbox
- MCP client with OAuth, Thompson sampling routing
- Cross-session learning, encrypted vault (AES-256-GCM + Argon2id)
- 1Password integration
