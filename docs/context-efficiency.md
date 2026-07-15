# Context Efficiency: Prompt Tiering, Cache Stability, and Retrieval

How Brainstorm avoids shipping its full ~12K-token system prompt for a
one-word task, and how it keeps the cacheable portion of that prompt stable
so BrainstormRouter's (BR) prompt caching actually pays off. Landed as
"Phase 5: complexity-aware prompt tiering + cache-prefix stability"
(`07b9d98`), building on the code-graph retrieval seam from an earlier phase.

## Complexity-aware prompt tiering

`buildSystemPrompt()` in `packages/core/src/agent/context.ts` takes an
optional `complexity?: Complexity` parameter. `getPromptTierForComplexity()`
maps it to a `PromptTier`:

```ts
export function getPromptTierForComplexity(
  complexity?: Complexity,
): PromptTier {
  if (complexity === "trivial" || complexity === "simple") return "minimal";
  return "full";
}
```

- **`trivial`/`simple` → `"minimal"`** — drops the following sections
  entirely: the STORM/BRAINSTORM.md project-context body, Conventions,
  Architecture Constraints, Stack, Dependency Rules, the repo map
  (`buildRepoMapSection`), the auto-detected style guide
  (`formatStyleContext`), and the memory dump (`loadMemoryContext`, up to
  ~2000 tokens on its own).
- **`moderate`/`complex`/`expert` → `"full"`** — today's existing behavior,
  unchanged.
- **`complexity` omitted (`undefined`) → `"full"`.** This matters: roughly
  twenty existing call sites across the CLI/IPC layer call `buildSystemPrompt(projectPath)`
  with no complexity argument at all, and all of them get byte-for-byte the
  same prompt as before this change — interactive chat and the eval harness
  are unaffected by construction, not by convention.

**Safety-relevant sections are never stripped, at any tier.** Verification
Commands (extracted from STORM frontmatter/body) and Protected Areas
("Don't touch") are emitted regardless of tier — dropping them would let an
under-classified task edit off-limits files or skip its build/test
verification step, and they're cheap (a few hundred tokens). Frontmatter
parsing itself is also unaffected by tier.

### Who sets `complexity`

`packages/cli/src/bin/brainstorm.ts`'s `run` command (single-shot,
non-interactive `brainstorm run "<prompt>"`) classifies the prompt with
`classifyTask()` from `@brainst0rm/router` and passes the resulting
`.complexity` straight into `buildSystemPrompt`:

```ts
let runComplexity: import("@brainst0rm/shared").Complexity | undefined;
try {
  const { classifyTask } = await import("@brainst0rm/router");
  runComplexity = classifyTask(finalPrompt).complexity;
} catch {
  runComplexity = undefined; // fall back to full prefix on any failure
}
const { prompt, segments, frontmatter } = buildSystemPrompt(
  projectPath,
  undefined,
  undefined,
  runComplexity,
);
```

A classifier failure of any kind falls back to `undefined` → the full prefix,
never a silently degraded one. The comment at the call site notes this is
safe specifically **because** `run` is single-shot: there's no cross-turn
cache within that single invocation to defeat by varying the prefix per call.

### Documented limitation: terse-but-real tasks in `brainstorm run`

Because `classifyTask` works off the prompt text, a genuinely substantive
coding task phrased tersely can classify as `trivial`/`simple` and get the
lean prompt — losing the repo map, conventions, and style guide that would
otherwise help the model match the codebase's patterns. This is a known,
documented trade-off (not a bug): the model can still discover those
conventions itself by reading files during the run; interactive chat and the
eval harness are unaffected since they don't pass a complexity value at all.

## Cache-prefix stability

Anthropic-style prompt caching only pays off if the cached prefix is
**byte-identical** across turns/sessions/machines. Three sources of
prefix-instability were closed in this phase:

1. **Absolute `cwd` relocated out of the cached zone.** `buildToolAwarenessSection()`
   used to embed `` `Current working directory: \`${process.cwd()}\`` `` — but
   this section is folded into the cacheable segment, and an absolute cwd
   string differs across an otherwise-identical logical session launched from
   a subdirectory or a git worktree, silently busting the cache on every such
   launch. That line is now omitted entirely; the working directory is
   already conveyed by project structure/STORM context, so nothing is lost.

2. **STORM/BRAINSTORM.md hierarchy load pinned to `projectPath`.**
   `loadHierarchicalStormFiles(projectPath, projectPath)` is now called with
   an explicit cwd argument equal to `projectPath`, rather than defaulting to
   `process.cwd()` — so the cacheable prefix no longer depends on the
   directory the CLI happened to be launched from (interactive chat already
   sets `projectPath = process.cwd()`, so this is byte-identical there; the
   difference only shows up for subdir/worktree launches).

3. **Deterministic, locale-independent skills ordering.** `loadSkillsFromDir()`
   in `packages/core/src/skills/loader.ts` now calls `readdirSync(dir).sort()`
   instead of using raw filesystem/OS iteration order (not guaranteed
   alphabetical, and can differ across machines/filesystems).
   `buildSkillsSection()` in `context.ts` additionally sorts the loaded skill
   list itself with a **locale-independent code-unit comparator**
   (`a.name < b.name ? -1 : a.name > b.name ? 1 : 0`), not `localeCompare`,
   which is ICU-locale-sensitive and can order the same two names differently
   on different machines/locales. Repo-map ordering is likewise deterministic.

`date`, git context, recent commits, and memory remain in the **dynamic**
(non-cacheable) segment, as before — they're expected to change per turn and
were never part of the cached prefix's stability contract.

## Code-graph retrieval in the dynamic segment

`buildSystemPrompt()` accepts a fifth, optional `retrieval?:
CodeGraphRetrievalOptions` argument carrying `taskText`. When present **and**
the prompt tier is `"full"` (i.e., `moderate`/`complex`/`expert`, or
`complexity` omitted), it calls `buildCodeGraphBlock(projectPath, retrieval)`:

```ts
if (!minimal && retrieval?.taskText) {
  const graphBlock = buildCodeGraphBlock(projectPath, retrieval);
  if (graphBlock) {
    dynamicParts.push(graphBlock);
  }
}
```

`buildCodeGraphBlock` lazily loads `@brainst0rm/code-graph` and runs a hybrid
BM25 search over the project's code graph, enriching hits with
definition line/signature (`defaultGraphRetrieve`), bounded by `topK`
(default 8 symbols) and a hard `charCap` (default 1500 chars) on the rendered
list. It fails closed: no task text, no graph index, or any retrieval error
all resolve to `null` and the block is simply omitted — retrieval can never
crash prompt assembly.

The retrieved-symbols block is placed in the **dynamic** segment, not the
cacheable one: retrieved symbols vary per task by definition, and putting
them in the cached prefix would defeat the cache on every distinct task. This
means `moderate`+ tasks get the "Relevant Code (retrieved via code-graph)"
block (when a graph index exists and there are hits), while `trivial`/`simple`
tasks skip retrieval entirely, consistent with skipping the repo map and
memory dump at that tier — trivial tasks pay for none of the heavier context
machinery.

## Files

- `packages/core/src/agent/context.ts` — `buildSystemPrompt`,
  `getPromptTierForComplexity`, `buildCodeGraphBlock`, `segmentsToSystemArray`
- `packages/core/src/skills/loader.ts` — deterministic `readdirSync().sort()`
- `packages/cli/src/bin/brainstorm.ts` — `run` command's `classifyTask` → tier wiring

## Related

- [docs/provider-agnostic-tool-calling.md](provider-agnostic-tool-calling.md) — the
  dual-namespace cache hint that makes the stable prefix documented here
  actually cache through BR
- [docs/edit-and-verify-loop.md](edit-and-verify-loop.md) — what happens to the edits
  the model makes with whichever tier of context it received
