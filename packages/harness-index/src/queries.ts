import type { HarnessIndexStore, IndexedArtifactRow } from "./index-store.js";

/**
 * Convenience query helpers — wrap the raw IndexStore queries with the
 * shapes the spec's "killer queries" need (`## AI Agent Traversal Patterns`
 * Tier 3+).
 *
 * These helpers return typed results suitable for both AI traversal and
 * desktop display; they do not perform LLM calls or external I/O.
 */

export interface OwnerSummary {
  owner: string;
  total: number;
  by_kind: Record<string, number>;
  artifacts: IndexedArtifactRow[];
}

/**
 * Show me everything Justin owns.
 *
 * Spec ref: cross-cutting threads — "People show up everywhere" (line ~46).
 */
export function ownerIndex(
  store: HarnessIndexStore,
  owner: string,
): OwnerSummary {
  const artifacts = store.byOwner(owner);
  const by_kind: Record<string, number> = {};
  for (const a of artifacts) {
    const kind = a.artifact_kind ?? "other";
    by_kind[kind] = (by_kind[kind] ?? 0) + 1;
  }
  return { owner, total: artifacts.length, by_kind, artifacts };
}

export interface ReferenceGraph {
  /** The reference target. */
  target: string;
  /** Artifacts whose `references` include this target — directly. */
  inbound: IndexedArtifactRow[];
  /** Total inbound count. */
  inbound_count: number;
}

/**
 * What depends on customers/accounts/acme?
 *
 * Returns artifacts that reference the target via the index's
 * artifact_references table. Used to answer "who references this?" without
 * loading every TOML file.
 */
export function referenceGraph(
  store: HarnessIndexStore,
  target: string,
): ReferenceGraph {
  const inbound = store.byReference(target);
  return { target, inbound, inbound_count: inbound.length };
}

export interface TagSummary {
  tag: string;
  count: number;
}

/**
 * What tags exist, ranked by frequency? Used by the desktop's filter
 * sidebar and by the gap-cluster detector to identify hotspots.
 *
 * Reads via the index's tag table; returns an ordered list.
 */
export function tagCloud(store: HarnessIndexStore): TagSummary[] {
  // Pull all artifacts, count tags. Could push this to SQL with GROUP BY
  // but the JS path is simpler and 20k artifacts × ~3 tags each is trivial.
  const counts = new Map<string, number>();
  for (const a of store.allArtifacts()) {
    // Use the byTag path: each artifact in the loop, fetch its tags…
    // Simpler approach: query directly. Since allArtifacts doesn't include
    // tags, fall back to a scan via byTag for known tags. We scan the
    // tags table directly via the underlying db.
  }
  // Direct query through the store's prepared statements — defensive
  // bracket access avoids leaking internal handles in the .d.ts.
  const db = (
    store as unknown as {
      db: {
        prepare(s: string): {
          all(): Array<{ tag: string; count: number }>;
        };
      };
    }
  ).db;
  const rows = db
    .prepare(
      `SELECT tag, COUNT(*) AS count
       FROM artifact_tags
       GROUP BY tag
       ORDER BY count DESC, tag ASC`,
    )
    .all();
  // Suppress unused warning; counts map exists for future enhancement
  // (e.g., merging with computed tags from external sources).
  void counts;
  return rows;
}

export interface StaleSummary {
  count: number;
  by_kind: Record<string, number>;
  artifacts: IndexedArtifactRow[];
}

/**
 * Artifacts that haven't been reviewed within the given window. Returns
 * a count + breakdown by kind for dashboard tiles.
 */
export function staleArtifacts(
  store: HarnessIndexStore,
  windowDays: number,
): StaleSummary {
  const cutoffMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const artifacts = store.staleSince(cutoffMs);
  const by_kind: Record<string, number> = {};
  for (const a of artifacts) {
    const kind = a.artifact_kind ?? "other";
    by_kind[kind] = (by_kind[kind] ?? 0) + 1;
  }
  return { count: artifacts.length, by_kind, artifacts };
}

/**
 * Cross-role parties — answers the spec's "find all customers who are
 * also investors" query. Note: this requires the parties registry to be
 * populated and indexed under artifact_kind = "party"; the actual role
 * graph lives in the party files themselves, not the index. This helper
 * returns the *party-kind* artifacts; resolving roles is a follow-up
 * step in the calling code (uses @brainst0rm/parties#buildPartyIndex).
 */
export function listParties(store: HarnessIndexStore): IndexedArtifactRow[] {
  return store.allArtifacts().filter((a) => a.artifact_kind === "party");
}

/**
 * Single-call dashboard summary — used by the desktop's harness-open
 * view to populate every tile without N round trips through the IPC
 * bridge.
 */
export interface HarnessDashboardSummary {
  total_artifacts: number;
  total_by_kind: Record<string, number>;
  total_owners: number;
  top_owners: Array<{ owner: string; count: number }>;
  top_tags: TagSummary[];
  stale_30d: StaleSummary;
  unresolved_drift_count: number;
}

export function dashboardSummary(
  store: HarnessIndexStore,
): HarnessDashboardSummary {
  const all = store.allArtifacts();

  const total_by_kind: Record<string, number> = {};
  const ownerCounts = new Map<string, number>();
  for (const a of all) {
    const kind = a.artifact_kind ?? "other";
    total_by_kind[kind] = (total_by_kind[kind] ?? 0) + 1;
    if (a.owner) {
      ownerCounts.set(a.owner, (ownerCounts.get(a.owner) ?? 0) + 1);
    }
  }

  const top_owners = Array.from(ownerCounts.entries())
    .map(([owner, count]) => ({ owner, count }))
    .sort((a, b) => b.count - a.count || a.owner.localeCompare(b.owner))
    .slice(0, 10);

  return {
    total_artifacts: all.length,
    total_by_kind,
    total_owners: ownerCounts.size,
    top_owners,
    top_tags: tagCloud(store).slice(0, 10),
    stale_30d: staleArtifacts(store, 30),
    unresolved_drift_count: store.unresolvedDrift().length,
  };
}
