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
