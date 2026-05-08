# Code Quality Scan — State

**Started:** 2026-04-15
**Status:** regenerating findings list after prior conversation was cleared

## Context

A prior scan found ~72 bugs. 10 have been fixed and landed on main:

- f5be922 fix(db): wrap sync_queue claimBatch in a single transaction
- 271d527 fix(db): safeParseJson for conversation and compaction row hydration
- 2a7cbbe fix(core): unwind tool-in-flight gate on stream error or abort
- 22d61fa fix(core): allocate compaction commitId before embedding it in summary tag
- 28b07c9 fix(tools): refuse to snapshot symlinks in the checkpoint store
- 59473b9 fix(agents): validate numeric frontmatter fields before storing on profile
- e122367 fix(agents): escape YAML keys before interpolating into RegExp
- e067d60 fix(plugin-sdk): reject plugin manifests that escape the plugin dir
- 73c035b fix(server): cap request body at 10MB to prevent memory DoS
- d36d967 fix(server): replace CORS wildcard with allowlist-reflected origins

The original 72-bug list was not persisted. This file exists so it doesn't happen again.

## Approach

Per ~/.claude/skills/code-quality-scan/SKILL.md:

- Read source files, reason about failure modes (no regex)
- Only report bugs with a specific trigger + failure scenario
- One bug → one fix → one commit

## Packages in scope

Critical (scan first):

- packages/core — agent loop, sessions, compaction, middleware
- packages/tools — filesystem, shell, git, sandbox
- packages/db — SQLite persistence
- packages/router — routing strategies, cost tracking
- packages/gateway — BR API client
- packages/vault — key manager, 1Password bridge
- packages/mcp — MCP client, OAuth

Secondary:

- packages/agents, packages/workflow, packages/hooks
- packages/eval, packages/providers, packages/config
- packages/cli, apps/desktop

## Findings

### packages/core (6)

1. **session/manager.ts:271** — compaction rehydrate uses count-based slice; if messages were deleted post-compaction the slice is wrong. Fix: store message IDs, not counts.
2. **agent/loop.ts:1149-1151** — 5s gateway-headers timeout resolves `null` silently; cost reconciliation lost with no log. Fix: log when headers unavailable.
3. **memory/manager.ts:246-256** — enforceCapacity TOCTOU: check→evict→write not atomic; concurrent writers can exceed cap. Fix: lock across sequence.
4. **middleware/builtin/proactive-compaction.ts:54** — `autoCompactInjected` flag is per-instance; reused middleware across loops never re-injects. Fix: per-session tracking.
5. **session/trajectory-reducer.ts:55,63,71** — `msg.content.match(...)` assumes string, crashes on object content. Fix: typeof guard like line 52.
6. **memory/manager.ts:831** — LRU eviction reconstructs path via basename pop, can collide across subdirs. Fix: store full dir path in fileSizes.

### packages/db + router + gateway + vault (10, some weak)

7. **db/src/vault.ts:78-89** — init() exists-check + write not atomic; corrupt-file backup uses `Date.now()` suffix, collides within ms. Fix: atomic rename.
8. **vault/src/vault.ts:105-109** — decrypted plaintext JSON parse error may carry plaintext refs in Error message. Fix: catch, zero, re-throw sanitized.
9. **vault/src/vault.ts:117-126** — concurrent `open()` calls can interleave `derivedKey`/`keys` with wrong password. Fix: serialize opens.
10. **gateway/src/client.ts:39** — CSRF token generated once in ctor, never refreshed over long-lived daemon. Fix: rotate per-request or periodically. [VERIFY: is this a real CSRF surface for an outbound client?]
11. **db/src/repositories.ts:1240-1246** — claimBatch dynamic `?` placeholder builder; agent admits "no actual injection", fragile pattern. [WEAK — likely drop]
12. **router/src/cost-tracker.ts:220-224** — `reconcile()` uses absolute `1e-6` tolerance; drift over many reconciles. Fix: relative tolerance.
13. **vault/src/resolver.ts:27-48** — if vault exists but unlock fails, silently falls through to 1Password with no severity warning. Fix: louder warning or throw.
14. **gateway/src/http.ts:29** — `AbortSignal.timeout(15_000)` aborts fetch but not `.text()` body read; slow-drip body hangs. Fix: race text() with timeout.
15. **vault/src/backends/op-cli.ts** — docstring vs TTL mismatch (30min vs 5min). [WEAK — doc fix at most]
16. **router/src/cost-tracker.ts:32-34** — small-token cost rounds to 0 in float math. [WEAK — correct float behavior, not a bug]

### packages/tools (15, some weak)

17. **builtin/docker-sandbox.ts:120** — `parseInt(codeStr,10) || 0` treats unparseable exit code as success. Fix: `Number.isNaN(n) ? 1 : n`.
18. **builtin/gh-security.ts:80** — `alertNumber` interpolated into gh path without numeric validation; shell metachars possible. Fix: assert integer.
19. **checkpoint/checkpoint.ts:55** — path safename replaces `[/\\]→__`; `/a/b.txt` and `/a__b.txt` collide in store. Fix: hash or encode separator.
20. **builtin/gh-pr.ts:86** — reviewers joined with `,`; gh expects repeated `--reviewer`. Fix: spread into separate flags.
21. **builtin/docker-sandbox.ts:194-198** — `translatePath()` prefix match treats `/home/user2` as sub of `/home/user`. Fix: ensure next char is `/` or end.
22. **builtin/file-cache.ts:41** — evicts only when `size >= max`, allows transient overflow. Fix: while-loop evict to `< max` after insert.
23. **builtin/shell.ts:281-307** — background spawn never calls `child.unref()`; keeps event loop alive. Fix: unref long-lived bg processes.
24. **builtin/file-write.ts:91-100** — atomic temp write `${safePath}.${uuid}.tmp` can exceed inode name limit; failure swallowed in catch. Fix: put temp in same dir with short name.
25. **builtin/process-manage.ts** — `process.kill(pid, SIGTERM)` no verification against pid reuse. Fix: track startTime, re-check before kill. [verify via /proc or ps]
26. **builtin/multi-edit.ts:10-34** — blocks `/var` entirely while file-write allows `/var/folders`, `/var/tmp`. [INCONSISTENCY, not a bug — resolve policy]
27. **builtin/batch-edit.ts:7-14** — stricter than file-write on symlink/tmp. [INCONSISTENCY, same category]
28. **builtin/web-search.ts:13** — static UA `BrainstormCLI/0.1` while web-fetch rotates. [WEAK — style]
29. **builtin/shell.ts:300-305** — bg timer vs close-event race; guarded by flag. [WEAK — already safe]
30. **builtin/docker-sandbox.ts:100** — sentinel UUID not escaped in wrapped command. [WEAK — UUID has no shell metachars]
31. **builtin/process-manage.ts:16-34** — cleanupStaleProcesses only fires on new spawn, not periodic. [WEAK — design, not bug]

### packages/mcp + agents + workflow + hooks + plugin-sdk (6)

32. **mcp/src/oauth.ts:27-72** — concurrent `getOAuthToken()` calls inside refresh window both fetch new tokens. Fix: in-flight promise dedupe map.
33. **agents/src/schemas.ts:4-46** — Zod schemas lack `.strict()`, allow unknown field passthrough. Fix: `.strict()` on each schema.
34. **workflow/src/artifact-store.ts:133** — `readArtifact()` falls back to `files[0]` when no match, returns wrong step's artifact. Fix: return null on miss.
35. **workflow/src/engine.ts:237** — step artifact pushed in-memory but `writeArtifact()` never called; crash loses all step outputs. Fix: persist per step.
36. **hooks/src/manager.ts:159** — mutates `results[results.length-1].blocked = true` after push; fragile under future reordering. Fix: set on construction.
37. **plugin-sdk/src/loader.ts:88** — path boundary check uses `resolve()` not `realpath`; symlink inside plugin dir escapes containment. Fix: `realpathSync()` before check.

## Summary

- 37 raw findings across 4 subagents
- ~28 strong (likely bet-money real bugs)
- ~9 weak/style/policy inconsistency

Target: fix the strong findings one-by-one, one commit each, per skill rules.
