/**
 * Hybrid Search — BM25 + name matching fused via Reciprocal Rank Fusion.
 *
 * Phase 2 delivers BM25 (FTS5) + LIKE-based name search + RRF.
 * Vector embeddings can be added later as a third ranking signal
 * without changing the public API.
 */

import type Database from "better-sqlite3";
import { searchBM25, type BM25Result } from "./bm25.js";

export interface HybridSearchResult {
  nodeId: string;
  file: string;
  name: string;
  kind: string;
  bm25Score: number;
  nameScore: number;
  fusedScore: number;
  communityId: string | null;
}

/**
 * Reciprocal Rank Fusion — combines multiple ranked lists.
 *
 * RRF score = Σ 1/(k + rank_i) across all ranking sources.
 * k=60 is the standard constant (Cormack et al. 2009).
 */
function reciprocalRankFusion(
  rankings: Array<Array<{ id: string; score: number }>>,
  k = 60,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    for (let i = 0; i < ranking.length; i++) {
      const id = ranking[i].id;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    }
  }
  return scores;
}

/**
 * Search the code graph using hybrid BM25 + name matching with RRF fusion.
 */
export function hybridSearch(
  db: Database.Database,
  query: string,
  opts?: { topK?: number },
): HybridSearchResult[] {
  const topK = opts?.topK ?? 20;

  // Ranking 1: BM25 via FTS5
  const bm25Results = searchBM25(db, query, topK * 2);
  const bm25Ranking = bm25Results.map((r) => ({
    id: r.nodeId,
    score: Math.abs(r.score), // FTS5 returns negative BM25 scores
  }));

  // Ranking 2: Name-based LIKE search (catches exact/prefix matches BM25 might rank lower)
  const nameResults = db
    .prepare(
      `
    SELECT id, name, kind, file, community_id AS communityId
    FROM nodes
    WHERE name LIKE ? AND kind != 'file'
    ORDER BY
      CASE WHEN name = ? THEN 0
           WHEN name LIKE ? THEN 1
           ELSE 2
      END,
      name
    LIMIT ?
  `,
    )
    .all(`%${query}%`, query, `${query}%`, topK * 2) as Array<{
    id: string;
    name: string;
    kind: string;
    file: string;
    communityId: string | null;
  }>;
  const nameRanking = nameResults.map((r, i) => ({
    id: r.id,
    score: nameResults.length - i, // position-based score
  }));

  // Fuse rankings via RRF
  const fusedScores = reciprocalRankFusion([bm25Ranking, nameRanking]);

  // Build result set with all metadata
  const nodeMap = new Map<
    string,
    { name: string; kind: string; file: string; communityId: string | null }
  >();
  for (const r of nameResults) {
    nodeMap.set(r.id, {
      name: r.name,
      kind: r.kind,
      file: r.file,
      communityId: r.communityId,
    });
  }
  // Also look up BM25-only results
  for (const r of bm25Results) {
    if (!nodeMap.has(r.nodeId)) {
      const node = db
        .prepare(
          "SELECT name, kind, file, community_id AS communityId FROM nodes WHERE id = ?",
        )
        .get(r.nodeId) as any;
      if (node) nodeMap.set(r.nodeId, node);
    }
  }

  // Build BM25 score lookup
  const bm25ScoreMap = new Map<string, number>();
  for (const r of bm25Results) {
    bm25ScoreMap.set(r.nodeId, Math.abs(r.score));
  }
  const nameScoreMap = new Map<string, number>();
  for (const r of nameRanking) {
    nameScoreMap.set(r.id, r.score);
  }

  // Assemble final results
  const results: HybridSearchResult[] = [];
  for (const [nodeId, fusedScore] of fusedScores) {
    const meta = nodeMap.get(nodeId);
    if (!meta) continue;

    results.push({
      nodeId,
      file: meta.file,
      name: meta.name,
      kind: meta.kind,
      bm25Score: bm25ScoreMap.get(nodeId) ?? 0,
      nameScore: nameScoreMap.get(nodeId) ?? 0,
      fusedScore,
      communityId: meta.communityId,
    });
  }

  // Sort by fused score descending
  results.sort((a, b) => b.fusedScore - a.fusedScore);

  return results.slice(0, topK);
}
