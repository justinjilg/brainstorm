# Brainstorm Harness Security Audit

Date: 2026-05-19
Scope: `/Users/justin/Projects/brainstorm`
Mode: repository code review plus automated dependency, contract, type, and test checks. No production credentials, AWS resources, or 1Password items were accessed during this audit.

## Executive Summary

The harness is a serious control-plane codebase: it has a coherent platform contract, local dev-token protection, CORS controls, ChangeSet concepts, shell sandbox checks, secret redaction utilities, and a meaningful contract-check suite. The biggest risk is that the approval boundary is not consistently enforced in the agent execution path. Several controls exist in code but are bypassed or weakened where the LLM loop is wired into tools.

The highest-priority remediation is to fix permission handling before using the harness against production infrastructure. Until that is done, authenticated chat/agent paths can reach tools that are intended to require explicit human approval.

## Remediation Status

Updated 2026-05-20 after splitting the audit work into reviewable PRs:

- Fixed in companion PR #360: confirm-class tool execution is blocked unless the permission check returns `"allow"`.
- Fixed in companion PR #360: server chat no longer forces `permissionCheck: () => "allow"`; by default it allows only `auto` tools and returns confirmation-required blocks for mutating tools.
- Fixed in companion PR #360: `process_spawn` uses the restricted scrubbed child environment.
- Fixed in companion PR #360: file tools check the real filesystem target, including symlinked files and symlinked parent directories, before read/write/edit.
- Fixed in companion PR #360: duplicate tool-name registration requires explicit `{ override: true }`, blocking silent plugin/tool shadowing.
- Fixed in companion PR #360: broker daemon POST endpoints require a local bearer token; clients send the token from options, env, or the generated broker-token file.
- Fixed in companion PR #360: the local preflight bypass script was renamed from `build:no-preflight` to `build:dangerous-skip-gates`.
- Fixed in companion PR #361: BR seam drift is guarded by the 20-route contract matrix and preflight gate #17.
- Fixed in this hardening PR: high-severity dependency paths are remediated. `next` is locked to `16.2.6`, `@xmldom/xmldom` is overridden to `0.8.13`, and `fast-uri` is overridden to `3.1.2`.
- Fixed in this hardening PR: server-side Keycloak/OIDC auth verifies RS256 JWKS tokens with exact issuer, `exp`/`nbf`, and `azp`/`aud` client binding. Legacy Supabase HS256 verification remains available only when `BRAINSTORM_JWT_ISSUER` is not configured.
- Fixed in this hardening PR: CLI login no longer persists unverified base64-decoded Keycloak claims.
- Fixed in this hardening PR: product connector execution sends tenant, trace, idempotency, and simulation binding headers/payload fields; write ChangeSets refuse execution unless the product simulation returns a `simulation_token`.
- Fixed in this hardening PR: malformed product tool schemas are quarantined instead of widened to `z.any()`.
- Fixed in this hardening PR: `web_fetch` rejects non-HTTP(S), credentials-in-URL, localhost/metadata/private/reserved IP ranges, DNS results resolving to blocked IPs, and unsafe redirects.
- Fixed in this hardening PR: relay WebSocket binding has max payload, pre-auth idle timeout, origin allow-list support, per-IP connection caps, disabled compression, and heartbeat termination.
- Fixed locally outside this PR: public web markdown routes render through a safe markdown helper and web security headers include CSP, HSTS, and Permissions-Policy. `apps/web/` is gitignored as a separate marketing-site project, so this needs separate propagation and its own audit in the canonical web repo.
- Already fixed/covered before this PR: server dev-token verification uses `timingSafeEqual()` with length checks and has regression coverage.
- Still open: route-level tenant/operator authorization on server endpoints, signing canonicalization convergence, typed BR SDK, canonical `apps/web` propagation, and production deploy/PR fanout for the cross-repo fixes.

## Automated Checks

- `npm run contract-check`: passed, 16/16 checks on this branch. Companion PR #361 promotes the BR contract matrix to gate #17.
- `npm run typecheck`: passed, 77/77 turbo tasks.
- Focused security/auth tests: passed, 40 tests across 7 files.
- `npm audit --json`: passed, 0 vulnerabilities in this clean repository checkout.
  - High-severity paths remediated: `next`, `@xmldom/xmldom`, `fast-uri`.
  - Former moderate paths for `turbo`, `vitest`/`vite`, `ws`, `hono`, `express-rate-limit`, `mermaid`, `uuid`, `brace-expansion`, and top-level `postcss` are remediated.
  - `apps/web/` is gitignored and absent from this PR branch; the canonical marketing-site repo should run its own audit when the local web hardening is propagated.
- `npm ci --ignore-scripts`: passed from the committed lockfile state, audited 1372 packages, 0 vulnerabilities.
- `npm test`: not rerun in the final hardening pass. Earlier audit run failed in `@brainst0rm/ingest`.
  - `packages/ingest/src/__tests__/ingest.test.ts:13` timed out after 5000ms.
  - `packages/ingest/src/__tests__/ingest.test.ts:27` timed out after 5000ms.
- Secret scan: no literal production secrets were confirmed in the repository scan. Hits were mostly `op://` references, test fixtures, and scripts that read secrets from 1Password at runtime.

## Findings

### Critical: Confirm-class tools execute without confirmation

`PermissionManager.check()` correctly returns `"confirm"` for tools that need approval in confirm mode, but the tool wrapper only blocks `"deny"` and executes everything else.

Evidence:

- `packages/core/src/permissions/manager.ts:98-136`
- `packages/tools/src/registry.ts:172-238`
- `packages/core/src/agent/loop.ts:668-678`

Impact:
Tools marked `permission: "confirm"` can execute in the agent loop without a human approval step. This includes mutating file operations, shell-like process management, and other high-risk actions. This undermines the central safety model described by the harness.

Recommendation:
Treat `"confirm"` as a hard pause, not as allow. The wrapper should return a structured approval request or route through a ChangeSet/confirmation queue. Add regression tests proving that `shell`, `file_write`, `file_edit`, `process_spawn`, and product ChangeSet tools do not execute in confirm mode until an explicit approval is recorded.

### Critical: HTTP chat routes explicitly allow all tools

Both non-streaming and streaming chat handlers pass `permissionCheck: () => "allow"` into the agent loop.

Evidence:

- `packages/server/src/server.ts:606-617`
- `packages/server/src/server.ts:681-693`

Impact:
Any authenticated caller to the server chat API can prompt the agent to use confirm-class tools. This bypasses both the permission manager and the intended ChangeSet approval posture. In a public or operator-facing deployment, this is a production-blocking issue.

Recommendation:
Wire server chat through the same permission manager and role model as the CLI, default remote chat to read-only tools, and require ChangeSet preview plus approval for writes. For v0.5 HAI chat, use capability registry metadata to dispatch reads directly and writes only through ChangeSets.

### Critical: `process_spawn` inherits the full process environment

The shell tool has explicit environment scrubbing, but `process_spawn` does not set `env` on `spawn()`, so the child inherits all environment variables from the harness process.

Evidence:

- `packages/tools/src/builtin/process-manage.ts:40-73`
- `packages/tools/src/builtin/shell.ts` has env scrubbing, but this path does not reuse it.

Impact:
If the harness process has cloud, 1Password, GitHub, OpenAI, or deployment credentials in its environment, a spawned background command can stage them into the workspace or send them over the network. Combined with the confirmation bypass above, this becomes a direct secret-exposure path.

Recommendation:
Reuse the shell environment scrubber for `process_spawn`, require approval, constrain `cwd` to the workspace, and add tests for `AWS_*`, `OP_*`, `GITHUB_*`, `OPENAI_*`, and generic token-like variables. Consider disabling `process_spawn` entirely in server mode unless an operator role and explicit approval are present.

### High: File tools can bypass sensitive-path blocking through symlinks

The file tools validate `resolve(cwd, filePath)` and then read/write the path. `resolve()` does not follow symlinks, while Node file operations do. The code comments acknowledge that realpath checking would be stronger.

Evidence:

- `packages/tools/src/builtin/file-read.ts:10-19`
- `packages/tools/src/builtin/file-read.ts:62-67`
- `packages/tools/src/builtin/sensitive-paths.ts:17-19`

Impact:
A malicious repository can include a symlink such as `workspace/creds -> ~/.aws/credentials`. `file_read` is an auto tool, so an injected prompt could read the symlink path without triggering the sensitive-path prefix checks.

Recommendation:
Use `realpathSync.native()` or equivalent before sensitive-path checks for read, write, edit, and multi-edit tools. Reject symlinks to blocked paths. Consider making symlink reads outside the workspace a confirm-class operation.

### High: JWT verification and authorization are not ready for the v0.5 identity model

Status 2026-05-20:
Keycloak/OIDC token verification is implemented for both CLI login and server bearer auth. The remaining gap is route-level tenant/operator authorization after authentication.

The server verifier is Supabase HS256-specific and does not validate Keycloak JWKS, issuer, audience, or `nbf`. It also comments that `platform_tenant_id` is required, but accepts tokens that only contain `sub`.

Evidence:

- `packages/godmode/src/jwt.ts:1-8`
- `packages/godmode/src/jwt.ts:67-98`
- `packages/server/src/server.ts:260-295`
- `packages/server/src/server.ts:492-502`

Impact:
The code is behind the v0.5 Keycloak direction and does not enforce tenant or operator roles per route. Any authenticated token accepted by the server can list tools, use chat, and approve ChangeSets; route handlers do not enforce role-specific authorization.

Recommendation:
Replace the Supabase-only verifier with Keycloak JWKS verification, require issuer/audience/expiration/nbf validation, require tenant claims for tenant-scoped routes, and enforce operator/admin roles for ChangeSet approval and server-side agent execution.

### High: Vulnerable dependencies were present

Initial `npm audit` reported 17 vulnerabilities, including 3 high severity issues. The direct high dependency was `next`, observed at `16.2.4`; additional high transitive issues were `@xmldom/xmldom <=0.8.12` and `fast-uri <=3.1.1`.

Impact:
The direct `next` vulnerability matters most for any deployed web surface. The transitive XML/URI issues matter depending on parsing and validation paths.

Status:
Remediated in this hardening PR. `next` is now `16.2.6`, `@xmldom/xmldom` is `0.8.13`, and `fast-uri` is `3.1.2`. `npm audit` now reports 0 vulnerabilities in this clean repository checkout. The canonical `apps/web` repository still needs its own propagation and audit pass because `apps/web/` is gitignored here.

### Medium: Product execution does not bind idempotency, trace, tenant, or simulation state

Status 2026-05-20:
Fixed in the generic product connector. Execute calls now carry tenant, trace, idempotency, and simulation binding, and write ChangeSets refuse unbound execution without a product-returned `simulation_token`.

Product connector execution posts only `{ tool, params }`. The ChangeSet path replays `originalParams` stored in local simulation state and does not include a product-signed simulation token, idempotency key, tenant context, or correlation headers.

Evidence:

- `packages/godmode/src/product-connector.ts:243-250`
- `packages/godmode/src/product-connector.ts:268-280`
- `packages/godmode/src/product-connector.ts:295-337`

Impact:
Cross-product actions are harder to audit and deduplicate, and a stale or tampered local ChangeSet simulation can be replayed without a server-side binding between simulation and execution.

Recommendation:
Add `trace_id`, `idempotency_key`, verified `tenant_id`, and product-signed simulation/ChangeSet binding to every product execute call. Product APIs should reject execute requests that do not match a valid prior simulation token for write operations.

### Medium: Product tool schemas fail open to `z.any()`

Status 2026-05-20:
Fixed in the generic product connector. Unsupported or ambiguous schemas are skipped/quarantined instead of widened.

Unknown JSON Schema types, arrays without item schemas, and objects without properties are converted to broad `z.any()` or `z.record(z.any())`.

Evidence:

- `packages/godmode/src/product-connector.ts:28-67`

Impact:
A malformed or compromised product tool descriptor can weaken input validation and widen the payload surface sent into product APIs.

Recommendation:
Fail closed on unsupported schema shapes, require explicit `additionalProperties` behavior, and log or quarantine product tools that cannot be translated safely.

### Medium: `web_fetch` is auto and can fetch arbitrary URLs with redirects

Status 2026-05-20:
Fixed. `web_fetch` now enforces HTTP(S), blocks embedded credentials and unsafe host/IP ranges, validates DNS answers, follows redirects manually, and revalidates every redirect target.

`web_fetch` is marked auto, accepts any URL string, and follows redirects. Contract validation warns on suspicious URLs but does not enforce network boundaries.

Evidence:

- `packages/tools/src/builtin/web-fetch.ts:43-60`

Impact:
If the harness runs in a cloud, VPC, or privileged workstation environment, this can become SSRF against internal services, link-local metadata, localhost-only admin endpoints, or network scanners.

Recommendation:
Require `http` or `https`, deny loopback/RFC1918/link-local/cloud metadata by default, resolve DNS and re-check post-redirect targets, and require confirmation for non-public or unclassified destinations.

### Medium: Web markdown pages render unsanitized HTML

Status 2026-05-20:
Fixed locally for the current web markdown routes. They now use a shared safe markdown renderer with raw HTML escaping and unsafe-link rejection. `apps/web/` is gitignored as a separate project, so these files need explicit propagation when packaging the change.

Two Next routes transform markdown with string replacement and render the result with `dangerouslySetInnerHTML`. The comments say content is developer-controlled, but the transformer does not escape raw HTML.

Evidence:

- `apps/web/src/app/blog/[slug]/page.tsx:22-32`
- `apps/web/src/app/blog/[slug]/page.tsx:72-75`
- `apps/web/src/app/cli/docs/[slug]/page.tsx:36-56`

Impact:
A malicious content commit, future CMS integration, or migrated docs source can become stored XSS on the public web app.

Recommendation:
Use a real markdown/MDX pipeline with sanitization, or escape HTML before applying minimal formatting. Add tests with `<script>`, event handlers, and `javascript:` links.

### Medium: WebSocket binding lacks pre-auth resource limits

Status 2026-05-20:
Fixed in the relay WebSocket binding with max payload, origin allow-list support, per-IP caps, pre-auth idle timeout, disabled compression, and heartbeat cleanup.

The WebSocket server disables compression, which is good, but does not set explicit `maxPayload`, origin validation, heartbeat/idle timeout, or connection rate limiting at accept time.

Evidence:

- `packages/relay/src/ws-binding.ts:55-95`

Impact:
An unauthenticated client can open connections and send large frames before endpoint/operator authentication logic gets a chance to reject the session.

Recommendation:
Set `maxPayload`, validate origins where browser clients are expected, add an unauthenticated idle timeout, and rate-limit connection attempts per source.

### Medium: Signing canonicalization is inconsistent across packages

`godmode` uses recursive sorted `JSON.stringify()` for HMAC event signing, while `relay` uses RFC 8785 JCS plus domain separation.

Evidence:

- `packages/godmode/src/signing.ts:35-52`
- `packages/relay/src/canonical.ts:1-20`
- `packages/relay/src/canonical.ts:105-129`

Impact:
Cross-language SDK extraction can drift if Python, Go, TypeScript, and browser verifiers do not use one canonical signing algorithm. This can produce unverifiable evidence envelopes or subtle replay/cross-context bugs.

Recommendation:
Standardize all evidence/event signing on the relay JCS plus domain-separation model, and publish test vectors for SDK Python, Go, and TypeScript.

### Low: Web app security headers are incomplete

Status 2026-05-20:
Fixed locally in `apps/web/next.config.ts` with CSP, HSTS, and Permissions-Policy coverage. `apps/web/` is gitignored as a separate project, so these files need explicit propagation when packaging the change.

The web app sets frame, content-type, and referrer headers, but not CSP, HSTS, or Permissions-Policy.

Evidence:

- `apps/web/next.config.ts:7-16`

Impact:
The missing headers reduce browser-side defense in depth, especially if the public web surface absorbs docs, router analytics, and operator routes under one domain.

Recommendation:
Add a strict CSP appropriate for Next.js, enable HSTS after domain cutover is stable, and set a conservative Permissions-Policy.

## Positive Controls Observed

- Non-loopback server mode refuses unauthenticated `/api/*` access when no JWT secret is configured.
- Dev mode uses a per-session bearer token instead of trusting loopback alone.
- `handleToolExecute` blocks direct REST calls to confirm/deny tools.
- Shell execution has a restricted sandbox and broad environment scrubbing.
- The repository includes security-focused tests for secret substitution, response filtering, content injection filtering, and tool contract validation.
- GitHub webhook signature verification is present before event handling.
- The vault uses modern authenticated encryption and file permission controls.
- Electron renderer isolation is enabled and raw HTML markdown is avoided in the desktop chat renderer.

## Architecture Notes

The harness is closest to a governed AI operations control plane. Its core safety promise is: the model can reason and propose, but mutation has to pass through tool permission checks, ChangeSets, or explicit operator approval. The codebase already contains most of the pieces needed for that model, but the execution path is inconsistent:

- CLI and server paths sometimes pass `permissionCheck: () => "allow"`.
- The tool wrapper currently treats `"confirm"` as executable.
- Server auth proves a caller is authenticated, but does not yet prove what tenant or operator authority they have.
- Product connector calls need stronger idempotency and evidence binding before they should operate across the converged platform.

For the v0.5 consolidation plan, these are not secondary hardening items. They are prerequisites for safely turning `/console/chat` into the HAI operator front door.

## Recommended Remediation Order

1. Add route-level tenant/operator authorization for ChangeSet approval, server-side agent execution, and `/console`-facing APIs.
2. Decide whether to wait for the next stable Next.js release or deliberately move to a fixed canary for the nested PostCSS advisory.
3. Standardize evidence/event signing on one canonical algorithm and publish SDK test vectors.
4. Convert BR route use from raw fetches plus contract matrix checks into a typed SDK generated from BR contract sources.
5. Land the cross-repo deploy/PR fanout in dependency order: BR contract source first, then brainstorm seam artifacts/tests, then product/Ops deploy fixes.

## Test Follow-ups

- Add server route tests for chat, ChangeSet approval, and tenant/role authorization.
- Add dependency-audit CI gating for high/critical vulnerabilities and a documented exception path for upstream-stable moderate advisories.
- Investigate the `@brainst0rm/ingest` timeouts; the failing tests appear to scan too much project state for a 5s default timeout.
