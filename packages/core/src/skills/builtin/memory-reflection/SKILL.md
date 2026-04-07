---
name: memory-reflection
description: Review and consolidate memory entries. Merge duplicates, resolve contradictions, update stale entries, and rebalance system vs archive tiers. Use when running /doctor or when triggered by KAIROS auto-reflection.
max_steps: 15
---

# Memory Reflection

Review all memory entries for quality, accuracy, and organization. This is the daemon's self-maintenance cycle.

## Process

### Phase 1: Inventory

Use `memory({ operation: "list" })` to see all entries grouped by tier.

### Phase 2: Analyze

For each system-tier entry:

1. Is it still accurate? Check against current project state.
2. Is it still relevant? If it hasn't been useful in the last few sessions, consider demoting to archive.
3. Is it a duplicate of another entry? Merge if so.
4. Does it contradict another entry? Keep the most recent, update or delete the other.

For each archive-tier entry:

1. Should it be promoted to system? If the project frequently needs this info, promote it.
2. Is it stale? References to files that no longer exist, outdated conventions, etc.
3. Can it be merged with a related entry?

### Phase 3: Act

- **Merge duplicates:** Read both entries, combine into one, delete the other.
- **Resolve contradictions:** Keep the one that matches current project state. Update description to note the change.
- **Promote high-value:** `memory({ operation: "promote", id: "..." })` for entries that belong in every prompt.
- **Demote low-value:** `memory({ operation: "demote", id: "..." })` for entries that are rarely accessed.
- **Delete stale:** `memory({ operation: "delete", id: "..." })` for entries that reference things that no longer exist.
- **Update outdated:** `memory({ operation: "write", ... })` to refresh content.

### Phase 4: Report

Summarize what changed:

- Entries merged: N
- Entries promoted: N
- Entries demoted: N
- Entries deleted: N
- Entries updated: N
- Total system entries: N
- Total archive entries: N

## Rules

- Be conservative — when uncertain, keep the entry.
- Never delete entries with `[keep]` in the name.
- Convert relative dates to absolute dates (e.g., "yesterday" → "2026-04-06").
- Each memory entry should have a clear, descriptive one-line description.
- System tier should be < 10 entries to avoid prompt bloat.
