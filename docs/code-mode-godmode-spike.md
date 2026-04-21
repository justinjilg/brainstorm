## Code Mode for GodMode + MCP + Plugin tools — spike

**Status:** Phase-1 shipped 2026-04-21 (uncommitted). Connector tool deferral wired behind `[godmode] deferToolSchemas` flag. Default off; opt-in per project.
**Owner:** Claude (implemented), JJ (approver).
**Created:** 2026-04-21.
**Branch suggestion:** `code-mode-tool-catalog` (work currently on `main`, uncommitted).

### What shipped today

The investigation found that **the infrastructure was already half-built**:

- `packages/tools/src/registry.ts` already has `deferred` flag + `listDeferred()` + `resolveDeferred()`
- `packages/tools/src/builtin/tool-search.ts` already implements the search/resolve loop
- `createToolSearchTool` is already in the default registry

Only MCP tools were marked deferred. GodMode and plugin tools were always eager-loaded. The shipped change extends the deferral flag to GodMode tools when a new config flag is set:

| File                                              | Change                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `packages/config/src/schema.ts`                   | Added `deferToolSchemas: boolean` to `godmodeSchema`, default false              |
| `packages/godmode/src/types.ts`                   | Mirrored field on `GodModeConfig` interface                                      |
| `packages/godmode/src/connector-registry.ts`      | Sets `tool.deferred = true` per registered tool when flag is on                  |
| `packages/godmode/src/prompt.ts`                  | Adds "Tool Discovery" instruction to system prompt when flag is on               |
| `packages/tools/src/builtin/tool-search.ts`       | Generalized description: covers MCP + GodMode + plugin tools                     |
| `packages/godmode/src/__tests__/codemode.test.ts` | 6 new tests covering deferral, resolve, ChangeSet always-on, and prompt behavior |

Test result: 105 godmode tests pass (was 99), 152 tools tests pass, 24 config tests pass. No regressions.

The `tool_execute` companion tool in the original design is unnecessary — the existing `ToolRegistry.toAISDKTools()` filters out deferred tools, and resolved tools become available natively in the next turn. Cleaner than Cloudflare's design.

### Origin

Cloudflare's [Enterprise MCP / Code Mode](https://blog.cloudflare.com/enterprise-mcp/) post (Agents Week, 4/15/2026) reports a 9,400 → 600 token reduction (94%) on tool catalog injection by collapsing N tool schemas behind two meta-tools: `portal_codemode_search` and `portal_codemode_execute`. The model discovers tools at runtime instead of having every schema pinned in the system prompt.

This pattern fills a gap our existing `packages/tools/src/progressive.ts` does not cover.

### What we already have

`progressive.ts` defines three tiers (`minimal`/`standard`/`full`) with hardcoded tool lists and routes by `Complexity` from the classifier. Important detail at `packages/tools/src/progressive.ts:127-139`:

```ts
const dynamicTools = allRegisteredTools.filter(
  (name) => !ALL_TIERED_TOOLS.has(name),
);
return [...tierTools, ...dynamicTools];
```

**Every tier carries all dynamic tools.** GodMode tools, MCP tools, and plugin tools are _not in any tier_ — by design (line comment: "the reason the user may be talking to the system and must never be filtered out"). So `minimal` tier saves token cost on built-in tools but does nothing for the dynamic catalog, which is where the bloat actually lives.

### Token cost today

Per-tool overhead in a tool schema (name + description + parameters JSONSchema + Zod metadata) averages ~70 tokens — confirmed by the existing estimator at `progressive.ts:166`.

Catalog sources visible in the codebase:

| Source                       | Count                               | How counted                                                                                                      |
| ---------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Built-in tools (`full` tier) | 58                                  | hardcoded list in `TIER_TOOLS.full`                                                                              |
| GodMode connectors           | 5 connectors × ~10 tools each = ~50 | discovered via `GET /api/v1/god-mode/tools` per connector at `packages/godmode/src/product-connector.ts:150-185` |
| ChangeSet meta-tools         | always-on                           | `getChangeSetTools()` at `packages/godmode/src/connector-registry.ts:109`                                        |
| MCP tools                    | variable per session                | normalized by `packages/mcp` tool adapter                                                                        |
| Plugin tools                 | variable per session                | injected via plugin SDK                                                                                          |

**Worst case in a fully-connected session:** ~58 built-in + ~50 GodMode + ~20 MCP + ~10 plugin ≈ **140 tools × 70 tokens = ~9,800 tokens of catalog injected into every prompt**.

That is the same order of magnitude as Cloudflare's 9,400-token baseline. Their 94% reduction claim is plausible against this surface.

### Proposal

Add a _third_ loading mode alongside the existing tier system:

| Mode                       | Use when                                                   | Catalog cost                                          |
| -------------------------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| `tiered` (existing)        | task complexity is classifiable + dynamic catalog is small | ~70 × tier-size + ~70 × dynamic-count                 |
| `codemode` (new)           | dynamic catalog > N tools (default N=20)                   | 2 meta-tools + 1 short instruction = ~250 tokens flat |
| `full` (existing fallback) | model explicitly opts out, debugging                       | ~70 × everything                                      |

Two new tools:

```ts
// Returns top-K matching tool descriptions, filtered by domain/permission.
tool_search({ query: string, domain?: string, limit?: number = 5 })
  → [{ name, description, schema_summary, domain, permission }]

// Executes a tool by name with full args. Schema validated server-side.
tool_execute({ name: string, args: Record<string, unknown> })
  → { result } | { error, suggested_args_fix? }
```

Implementation lives in `packages/tools/src/codemode.ts`. The search index is built once at session start from `ToolRegistry.list()`, indexed by:

1. **Embeddings** of `name + description` for semantic match — reuse the existing TF-IDF index from `packages/core/src/semantic-search`. Upgrading to vectors is a separate spike.
2. **Domain tags** (`domain` from GodMode tools, `category` from MCP tools, fallback to package prefix for built-in).
3. **Permission level** so `tool_search` can pre-filter unsafe tools per active role.

**Critical detail Cloudflare doesn't address but we have to:** the model needs to know this mode is active. The system prompt addition is one paragraph:

> Tools beyond the core set are not listed individually. Use `tool_search(query)` to discover relevant tools by intent, then `tool_execute(name, args)` to invoke them. Schemas are returned by `tool_search`. ChangeSet tools (`gm_changeset_*`), task tools, and core file/shell tools are always available without search.

### What stays always-loaded (not behind search)

The tools an agent reaches for _every turn_ have to stay in the prompt — search overhead per call is real (one extra round-trip + ~150 tokens). Always-loaded set:

- All `minimal` tier (`file_read`, `file_write`, `file_edit`, `shell`, `glob`)
- ChangeSet meta-tools (`gm_changeset_create`, `gm_changeset_approve`, `gm_changeset_reject`)
- Task tools (`task_create`, `task_update`, `task_list`)
- The two new meta-tools (`tool_search`, `tool_execute`)

That's ~13 tools × 70 = ~910 tokens always-on. Everything else is search-discoverable.

### Expected reduction (estimate, to verify in spike)

| Catalog     | Today (tokens) | With codemode (tokens)             | Reduction |
| ----------- | -------------- | ---------------------------------- | --------- |
| Built-in 58 | 4,060          | 350 (minimal stay) + 60 (overhead) | 90%       |
| GodMode 50  | 3,500          | 0 (all behind search)              | 100%      |
| MCP 20      | 1,400          | 0 (all behind search)              | 100%      |
| Plugin 10   | 700            | 0 (all behind search)              | 100%      |
| **Total**   | **~9,660**     | **~660 (excluding meta-tools)**    | **~93%**  |

This matches Cloudflare's 94% claim within rounding.

### Risk

1. **Search latency.** Every novel tool need adds one round-trip. For multi-tool workflows this could net out to _more_ tokens (search + execute pairs). Mitigation: aggressive cache by `(query, role)` per session; track avg searches/turn in the spike's measurement phase.
2. **Model regression.** Some models reason better with the full catalog visible. Mitigation: per-model opt-out flag in `model_capabilities` — Opus/Sonnet/GPT-5.4 likely fine, smaller models may need full catalog.
3. **Tool discovery quality.** If `tool_search("disable user's laptop")` doesn't surface `msp_isolate_endpoint`, the user's request fails opaquely. Mitigation: bench against a fixed query set that exercises every connector before shipping behind a flag.
4. **Permission/role drift.** A search result might leak the _existence_ of a tool the role can't actually call. Mitigation: filter at search time by active role's `tool_permissions`.
5. **Cache invalidation on connector reconnect.** New connector → search index needs rebuild. Mitigation: subscribe to ToolRegistry change events (event already exists per `connectGodMode` callsite — confirm in spike).

### Acceptance for the spike (1–2 days)

- [ ] Measure actual token cost of catalog injection in a representative session: brand-new chat with all GodMode connectors healthy + at least one MCP server (Notion or Linear) connected. Numbers go in `BENCHMARK.md`.
- [ ] Implement `tool_search` and `tool_execute` in `packages/tools/src/codemode.ts` with TF-IDF index reuse.
- [ ] Wire the prompt-mode switch into `packages/core` system-prompt builder. Default off, opt-in via `brainstorm.toml` `[tools] mode = "codemode"`.
- [ ] Add 12-query test fixture covering: 3 GodMode operations, 3 MCP operations, 3 built-in operations, 3 ambiguous (should fail gracefully).
- [ ] Compare token cost + answer quality (LLM-judge) on the 12 queries: tiered vs codemode. Result table in spike output.
- [ ] No regression on the existing `progressive.test.ts` suite.

### Decision points captured for JJ

1. **Default-on or opt-in?** Cloudflare's MCP Portal is explicitly opt-in per portal. I'd recommend opt-in for one release (one major version), then default-on in the version after, with a flag to revert.
2. **Per-model opt-out?** Currently I propose adding a `supports_codemode: bool` to model capabilities. Alternative: just always use codemode and trust the model to call `tool_search`. The first is safer; the second is simpler.
3. **Where does the search index live?** Per-session (rebuilt every chat) is simple but slow on session start; cached on disk with invalidation on ToolRegistry changes is faster but adds a moving part. Recommend per-session for the spike, optimize later.

### Strategic notes

- This is the highest-leverage Cloudflare-Agents-Week absorption: pure technique, no vendor lock-in, immediate token savings across every storm session.
- It does **not** compete with `progressive.ts` — they layer. Tiered loading still picks built-in tools by complexity; codemode collapses the _dynamic_ catalog (GodMode + MCP + plugins) which tiers can't classify.
- Once shipped, the same `tool_search` + `tool_execute` surface can be exposed _as_ an MCP server for external Claude Code users — meaning Brainstorm becomes a Code-Mode-compatible backend others can consume. This is the distribution play to pair with the [MCP Portal publishing plan](#).

### Resume checklist

When picking this up:

1. Re-verify current dynamic catalog size — connect every available GodMode connector, count tools.
2. Check `packages/core/src/semantic-search` is still TF-IDF (not yet vectorized) so the search index implementation matches.
3. Branch from `main` as `code-mode-tool-catalog`.
4. Spike target is _measurement + prototype_, not full ship. Ship is a follow-up PR after JJ approves the numbers.
