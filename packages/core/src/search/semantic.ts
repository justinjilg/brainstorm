/**
 * Semantic Code Search — TF-IDF based code search.
 *
 * Indexes project files by extracting symbols and code snippets,
 * builds TF-IDF vectors, and supports cosine similarity search.
 * Zero external dependencies — pure math fallback when no embedding model available.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRepoMap, type RepoMapEntry } from "../agent/repo-map.js";
import {
  resolveEmbeddingProvider,
  openEmbeddingStore,
  denseCosine,
  hashContent,
  type EmbeddingProvider,
  type EmbeddingResolveOptions,
  type EmbeddingStore,
} from "./embeddings.js";

export interface SearchResult {
  filePath: string;
  symbolName: string | null;
  snippet: string;
  score: number;
}

interface TFIDFDocument {
  filePath: string;
  symbolName: string | null;
  snippet: string;
  terms: Map<string, number>;
}

// ── TF-IDF Engine ────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && t.length < 40);
}

function computeTF(tokens: string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const t of tokens) {
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  // Normalize by doc length
  const len = tokens.length || 1;
  for (const [k, v] of freq) {
    freq.set(k, v / len);
  }
  return freq;
}

function computeIDF(docs: TFIDFDocument[]): Map<string, number> {
  const docCount = docs.length || 1;
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of doc.terms.keys()) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    idf.set(term, Math.log(docCount / count));
  }
  return idf;
}

function cosineSimilarity(
  a: Map<string, number>,
  b: Map<string, number>,
  idf: Map<string, number>,
): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  const allTerms = new Set([...a.keys(), ...b.keys()]);
  for (const term of allTerms) {
    const idfVal = idf.get(term) ?? 0;
    const aVal = (a.get(term) ?? 0) * idfVal;
    const bVal = (b.get(term) ?? 0) * idfVal;
    dotProduct += aVal * bVal;
    normA += aVal * aVal;
    normB += bVal * bVal;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

// ── Indexing ─────────────────────────────────────────────────────────

function extractSnippets(
  filePath: string,
  fullPath: string,
  entry: RepoMapEntry,
): TFIDFDocument[] {
  const docs: TFIDFDocument[] = [];

  try {
    const content = readFileSync(fullPath, "utf-8");
    const lines = content.split("\n");

    // Index the whole file as one document
    const fileTokens = tokenize(content.slice(0, 2000));
    if (fileTokens.length > 0) {
      docs.push({
        filePath,
        symbolName: null,
        snippet: lines.slice(0, 10).join("\n"),
        terms: computeTF(fileTokens),
      });
    }

    // Index each exported symbol with surrounding context
    for (const symbol of entry.exports.slice(0, 20)) {
      const symbolIdx = lines.findIndex((l) => l.includes(symbol));
      if (symbolIdx < 0) continue;

      const start = Math.max(0, symbolIdx - 2);
      const end = Math.min(lines.length, symbolIdx + 8);
      const snippet = lines.slice(start, end).join("\n");
      const tokens = tokenize(`${symbol} ${snippet}`);

      if (tokens.length > 0) {
        docs.push({
          filePath,
          symbolName: symbol,
          snippet,
          terms: computeTF(tokens),
        });
      }
    }
  } catch {
    // Skip unreadable files
  }

  return docs;
}

// ── Public API ───────────────────────────────────────────────────────

let _indexCache: {
  projectPath: string;
  docs: TFIDFDocument[];
  idf: Map<string, number>;
  ts: number;
} | null = null;

const INDEX_TTL_MS = 60_000; // 1 minute cache

/**
 * Index project files for semantic search.
 * Uses buildRepoMap for file discovery and TF-IDF for vectorization.
 */
export function indexProject(projectPath: string): {
  docs: TFIDFDocument[];
  idf: Map<string, number>;
} {
  if (
    _indexCache &&
    _indexCache.projectPath === projectPath &&
    Date.now() - _indexCache.ts < INDEX_TTL_MS
  ) {
    return { docs: _indexCache.docs, idf: _indexCache.idf };
  }

  const map = buildRepoMap(projectPath, 50);
  const docs: TFIDFDocument[] = [];

  for (const entry of map.entries) {
    const fullPath = join(projectPath, entry.file);
    docs.push(...extractSnippets(entry.file, fullPath, entry));
  }

  const idf = computeIDF(docs);

  _indexCache = { projectPath, docs, idf, ts: Date.now() };
  return { docs, idf };
}

/**
 * Search project code using TF-IDF cosine similarity.
 * Returns top-K results ranked by relevance.
 */
export function semanticSearch(
  query: string,
  projectPath: string,
  topK = 10,
): SearchResult[] {
  const { docs, idf } = indexProject(projectPath);
  if (docs.length === 0) return [];

  const queryTerms = computeTF(tokenize(query));
  if (queryTerms.size === 0) return [];

  const scored: SearchResult[] = docs.map((doc) => ({
    filePath: doc.filePath,
    symbolName: doc.symbolName,
    snippet: doc.snippet,
    score: cosineSimilarity(queryTerms, doc.terms, idf),
  }));

  return scored
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ── Embedding-backed search (with TF-IDF fallback) ───────────────────

export interface EmbeddedSearchOptions extends EmbeddingResolveOptions {
  /**
   * Persistence store for cached embeddings. Omit to use the shared
   * code_embeddings store; pass `null` to disable persistence entirely.
   */
  store?: EmbeddingStore | null;
}

/**
 * Embed the indexed docs, using the store as a content-hash-keyed cache and
 * only calling the provider for cache misses. Returns vectors aligned to `docs`
 * (null for any doc the provider failed to embed).
 */
async function embedDocs(
  provider: EmbeddingProvider,
  docs: TFIDFDocument[],
  projectPath: string,
  store: EmbeddingStore | null,
): Promise<Array<number[] | null>> {
  const texts = docs.map((d) =>
    d.symbolName ? `${d.symbolName}\n${d.snippet}` : d.snippet,
  );
  const hashes = texts.map(hashContent);
  const vectors: Array<number[] | null> = new Array(docs.length).fill(null);

  const misses: number[] = [];
  for (let i = 0; i < docs.length; i++) {
    const cached = store?.get(hashes[i], provider.id) ?? null;
    if (cached) vectors[i] = cached;
    else misses.push(i);
  }

  if (misses.length > 0) {
    const embedded = await provider.embed(misses.map((i) => texts[i]));
    for (let j = 0; j < misses.length; j++) {
      const i = misses[j];
      const vec = embedded[j];
      if (!vec) continue;
      vectors[i] = vec;
      store?.put({
        projectPath,
        filePath: docs[i].filePath,
        symbolName: docs[i].symbolName,
        snippet: docs[i].snippet,
        hash: hashes[i],
        model: provider.id,
        vector: vec,
      });
    }
  }

  return vectors;
}

/**
 * Semantic search that uses a real embedding backend when one is configured,
 * and transparently falls back to the synchronous TF-IDF `semanticSearch`
 * otherwise (no backend, empty results, or any failure). Never throws.
 *
 * This is the async counterpart to `semanticSearch`: the single seam where a
 * real embedding model plugs in. Embedding use is opt-in (off by default) —
 * see `resolveEmbeddingProvider`.
 */
export async function semanticSearchEmbedded(
  query: string,
  projectPath: string,
  topK = 10,
  opts: EmbeddedSearchOptions = {},
): Promise<SearchResult[]> {
  const provider = resolveEmbeddingProvider(opts);
  // No embedding backend configured/available → graceful TF-IDF fallback.
  if (!provider) return semanticSearch(query, projectPath, topK);

  try {
    const { docs } = indexProject(projectPath);
    if (docs.length === 0) return [];

    const store =
      opts.store === undefined ? openEmbeddingStore() : (opts.store ?? null);
    const vectors = await embedDocs(provider, docs, projectPath, store);

    const [queryVec] = await provider.embed([query]);
    if (!queryVec) return semanticSearch(query, projectPath, topK);

    const scored: SearchResult[] = [];
    for (let i = 0; i < docs.length; i++) {
      const vec = vectors[i];
      if (!vec) continue;
      scored.push({
        filePath: docs[i].filePath,
        symbolName: docs[i].symbolName,
        snippet: docs[i].snippet,
        score: denseCosine(queryVec, vec),
      });
    }

    const results = scored
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    // If the backend produced nothing usable, fall back rather than returning
    // an empty list — feature-detect at the result level too.
    if (results.length === 0) return semanticSearch(query, projectPath, topK);
    return results;
  } catch {
    // Any backend/store failure → never crash a turn; degrade to TF-IDF.
    return semanticSearch(query, projectPath, topK);
  }
}
