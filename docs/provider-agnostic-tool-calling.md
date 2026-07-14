# Provider-Agnostic Tool Calling

How Brainstorm drives tool calls against ANY tool-capable model reachable through
BrainstormRouter (BR) — not just Anthropic — while keeping the tool registry,
trajectory recording, TUI events, and prompt caching all working under one
canonical vocabulary.

This is the "Phase 1: BR any-tool-model reliability" work
(`335dfadf5`), plus the model-catalog import that lets the router see those
models in the first place (also part of `335dfad`) and the cache-accounting
foundation that measures the caching payoff (`1b04f81`).

## 1. Seeing the models: BR model-catalog import

Brainstorm ships a curated static model list (`CLOUD_MODELS` in
`packages/providers/src/cloud/models.ts`). That list can't know about every
model BR serves. `packages/providers/src/cloud/brainstorm-saas.ts` adds
`fetchBrModelCatalog()`, which:

- Calls BR's OpenAI-compatible `GET /v1/models`.
- For each returned entry, synthesizes a `ModelEntry` via
  `synthesizeModelEntry()` — id, provider (derived from the `provider/model`
  id prefix), and a `capabilities` block.
- Sets `capabilities.toolCalling` conservatively: `catalogAdvertisesToolCalling()`
  only returns `true` if the catalog entry explicitly says so (nested
  `capabilities.tool_calling`/`toolCalling`/`tools`/`function_calling`, a flat
  flag, or a `features` array containing `"tools"`/`"tool_calling"`/etc.). A
  missing/ambiguous signal defaults to `false` — a false positive would let the
  router pick a model that then rejects tool calls at runtime, which is worse
  than not offering it.
- Similarly infers `capabilities.vision` from `catalogAdvertisesVision()`.
- Fills `qualityTier`/`speedTier` with a neutral `3` (BR-discovered models have
  no curated ranking) and zero placeholder pricing (real cost comes from the
  BR reconciliation headers, not a static table).

`fetchBrModelCatalog` is resilient by contract: network error, timeout,
non-2xx, or malformed body all resolve to `[]` rather than throwing, so a bad
connection never blocks registry construction. It's timeout-bounded
(`timeoutMs`, default 5000ms via `AbortSignal.timeout`) and its `fetch` is
injectable (`BrCatalogOptions.fetchImpl`) so tests can stub it.

`packages/providers/src/registry.ts` wires this in `createProviderRegistry()`:
when a BR API key is configured, it calls `fetchBrModelCatalog(brApiKey, { fetchImpl: options.brCatalogFetch })`
and merges the result into `allModels`, skipping any id that already exists in
the static/curated set — **static entries win on collision** (curated
capability/pricing data beats a synthesized placeholder).

`getProvider(modelId)` in the same file resolves a model id to a callable
provider function. Previously, when no direct SDK key matched and BR wasn't
configured, it silently returned the bare model-id string, which then failed
deep inside the AI SDK with an opaque error. It now throws a descriptive error
naming the model id and which provider keys were checked — a diagnosable
failure instead of a silent one.

## 2. Per-provider tool-name mapping

Brainstorm's tool registry and executors are keyed by canonical (Anthropic
convention) names: `shell`, `file_read`, `file_write`, `file_edit`, `subagent`,
etc. Non-Anthropic models were largely trained on different tool names for the
same actions, and tool-call accuracy improves when the model sees the name it
expects.

`packages/router/src/tool-mappings.ts` defines the map, keyed by canonical
name → provider-specific name:

```ts
export const PROVIDER_TOOL_NAMES: Record<string, Record<string, string>> = {
  openai: {
    shell: "shell_command",
    file_read: "read_file",
    file_write: "write_file",
    file_edit: "apply_patch",
  },
  google: {
    shell: "run_shell_command",
    file_write: "write_file",
    file_edit: "replace",
  },
  deepseek: {
    shell: "shell_command",
    file_read: "read_file",
    file_write: "write_file",
  },
};
```

Only tools that need renaming are listed; unlisted tools (and Anthropic
itself, which has no entry) pass through unchanged. `getProviderFamily()`
strips a `provider/model` id down to the family (`"openai/gpt-5.4"` →
`"openai"`).

`packages/router/src/tool-adapter.ts` builds on this:

- `adaptToolsForModel(tools, model)` — renames the **outbound** tool set so
  the model sees provider-native names, and returns a `reverseMap` (adapted
  name → canonical name) for that model's provider family. Anthropic (no
  mapping) returns the tools unchanged and an empty map.
- `reverseToolName(providerName, model)` — the **inbound** counterpart: given
  a tool-call name as emitted by the model, look up the mapping for that
  model's provider family and return the canonical name, without needing a
  pre-built `reverseMap` in hand. Unmapped/unknown names pass through
  unchanged.

Before `335dfad`, only the outbound rename was wired — the reverse map existed
but nothing called it, so tool dispatch, trajectory recording, and TUI events
still compared against `part.toolName` (the provider-native name) instead of
canonical. `packages/core/src/agent/loop.ts` now calls `reverseToolName()` at
every point that observes a tool-call or tool-result part in the stream, and
compares/records under the canonical name from there on:

```ts
const canonicalName = reverseToolName(part.toolName, decision.model);
```

This canonical name is what feeds `toolCallResults`, the `file_read`/
`file_write`/`file_edit`/`shell`/`subagent` comparisons used for turn-context
tracking (`filesRead`, `filesWritten`), build-state capture, loop detection,
and the `tool-call-start`/`tool-call-result` events the TUI renders. The same
commit fixed a latent bug where the canonical shell tool is actually named
`shell` (not `bash`) — the old rename entry never matched the real tool name,
so it was dead code until this fix.

`packages/core/src/agent/subagent.ts` (`spawnSubagent`) applies the same
outbound adaptation (`adaptToolsForModel`) to the subagent's tool set and the
same inbound `reverseToolName` when recording the subagent's `toolCallNames`,
so a non-Anthropic subagent model's tool calls are tracked under canonical
names too — consistent with the parent loop.

## 3. Streamed tool-call hardening

BR's OpenAI-compatible proxy has been observed to occasionally send a
duplicate or malformed terminal `finish`/`finish-step` event mid-tool-call
assembly. Left unhandled, this can look like the model produced an empty turn
(text and tool-call counts both zero) when it actually intended to act.

`loop.ts` tracks two additional signals per turn:

- `pendingToolInputs` — incremented on `tool-input-start`, decremented when
  that call materializes as a dispatchable `tool-call` part. A residual > 0
  after the stream ends means a tool call began assembling but never
  completed.
- `finishReason`/`finishPartCount` — captured from `finish`/`finish-step`
  parts. If the terminal `finishReason` is `"tool-calls"` but zero tool calls
  were dispatched, the assembly was truncated, not genuinely empty.

```ts
const toolCallTruncated =
  pendingToolInputs > 0 ||
  (finishReason === "tool-calls" && toolCallCount === 0);
```

`toolCallTruncated` is treated as a turn failure alongside the pre-existing
`isEmpty` check (`shouldRetry = isEmpty || toolCallTruncated`): it records a
circuit-breaker failure (`"truncated_tool_call"` vs `"empty_response"`),
triggers the same fallback-model retry path, and — if all fallbacks are
exhausted — surfaces a `fallback-exhausted` event with a reason string that
distinguishes "truncated their tool-call streams" from "returned empty
responses" so the operator knows whether the model said nothing or was cut
off mid-action.

## 4. Cache-through-BR: the dual-namespace cache hint

Anthropic's prompt caching is normally invoked with
`providerOptions.anthropic.cacheControl`, read directly by `@ai-sdk/anthropic`.
When a model is routed through BR's OpenAI-compatible surface
(`@ai-sdk/openai-compatible`), that Anthropic-specific provider option is
never read — caching would silently stop working on the BR hop.

`packages/core/src/agent/context.ts` (`segmentsToSystemArray`) now emits a
**second**, provider-agnostic namespace alongside the Anthropic one, on the
same cacheable segment:

```ts
providerOptions: {
  anthropic: { cacheControl: EPHEMERAL_CACHE_CONTROL },
  openaiCompatible: { cache_control: EPHEMERAL_CACHE_CONTROL },
}
```

`@ai-sdk/openai-compatible` spreads every key of its `openaiCompatible`
namespace onto the outgoing `{ role: "system", ... }` message object
verbatim, so the request body BR receives is
`{ role: "system", content, cache_control: { type: "ephemeral" } }`. BR must
forward that `cache_control` field unchanged on the system message it proxies
upstream for caching to actually take effect; the hint is inert (a harmless
extra JSON field) against any backend that doesn't look for it, so it's safe
to always send. The direct-Anthropic path is unaffected.

Only the **last** cacheable segment gets a breakpoint — `segmentsToSystemArray`
finds `lastCacheableIndex` and applies the hint there only, even though
Anthropic allows up to 4 breakpoints per request. The code deliberately stays
at one: the stable prefix is the only thing worth a breakpoint today.

### Measuring whether it pays off

`packages/gateway/src/headers.ts`/`types.ts` parse an `x-br-cache-hit-tokens`
(or passthrough `prompt_cache_hit_tokens`) header into
`GatewayFeedback.cacheHitTokens`, and `packages/core/src/agent/loop.ts`'s
`onStepFinish` reads `usage.cachedInputTokens` off the AI SDK v6 usage object
and passes it to `CostTracker.record()` as `cachedTokens`. `CostTracker`
(`packages/router/src/cost-tracker.ts`) bills the cached subset at a reduced
rate (default 0.1× the input rate, configurable via
`pricing.cachedInputPer1MTokens`), clamps `cachedTokens <= inputTokens`, and
tracks a running `sessionCachedTokens` counter — closing the "$0 cost / can't
see caching" blind spot that made it impossible to tell whether the cache hint
was doing anything.

## Files

- `packages/providers/src/cloud/brainstorm-saas.ts` — `fetchBrModelCatalog`,
  `synthesizeModelEntry`, `catalogAdvertisesToolCalling`/`Vision`
- `packages/providers/src/registry.ts` — catalog merge, `getProvider` error path
- `packages/router/src/tool-mappings.ts` — `PROVIDER_TOOL_NAMES`, `getProviderFamily`
- `packages/router/src/tool-adapter.ts` — `adaptToolsForModel`, `reverseToolName`
- `packages/core/src/agent/context.ts` — `segmentsToSystemArray`, dual cache namespace
- `packages/core/src/agent/loop.ts` — inbound rename wiring, truncated tool-call detection
- `packages/core/src/agent/subagent.ts` — subagent tool adaptation
- `packages/gateway/src/headers.ts`, `packages/gateway/src/types.ts` — cache-hit header parsing
- `packages/router/src/cost-tracker.ts` — cached-token billing

## Related

- [docs/edit-and-verify-loop.md](edit-and-verify-loop.md) — how tool calls that edit
  files are applied and (optionally) verified
- [docs/context-efficiency.md](context-efficiency.md) — how the cacheable prefix this
  section's cache hint protects is kept stable
