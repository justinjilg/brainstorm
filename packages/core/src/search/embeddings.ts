/**
 * Embedding backend for semantic code search.
 *
 * Provides a pluggable embedding-provider abstraction that sits behind the
 * TF-IDF search in semantic.ts. Everything here is feature-detected and
 * degrades gracefully: when no embedding backend is configured or reachable,
 * callers fall back to the pure in-memory TF-IDF path with NO error.
 *
 * Default: OFF. Remote embeddings incur cost/latency, so real embeddings are
 * opt-in (via env / injected provider). A local Ollama endpoint is the default
 * backend when enabled — zero per-call cost and on-prem, matching the project's
 * open/sovereign positioning.
 */

import { createHash } from "node:crypto";
import { getDb } from "@brainst0rm/db";

/** A backend that turns text into dense vectors. */
export interface EmbeddingProvider {
  /** Stable id used for cache-invalidation (model identity). */
  id: string;
  /** Embedding dimensionality, if known ahead of time. */
  dim?: number;
  /** Embed a batch of texts → one dense vector per input, order-aligned. */
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingResolveOptions {
  /**
   * Directly inject a provider (used in tests / programmatic callers). If the
   * key is present at all it wins — pass `null` to explicitly force the TF-IDF
   * fallback path even when env would otherwise enable embeddings.
   */
  provider?: EmbeddingProvider | null;
  /** Force-enable/disable, overriding env feature-detection. */
  enabled?: boolean;
  /** Ollama-compatible base URL (default http://localhost:11434). */
  baseUrl?: string;
  /** Embedding model name (default from env or nomic-embed-text). */
  model?: string;
}

/**
 * Resolve an embedding provider from options + environment, or null when no
 * backend is configured. Off by default — only returns a provider when
 * explicitly enabled, so a stock install pays zero embedding cost/latency.
 */
export function resolveEmbeddingProvider(
  opts: EmbeddingResolveOptions = {},
): EmbeddingProvider | null {
  // Explicit injection wins (including an explicit null to force fallback).
  if ("provider" in opts) return opts.provider ?? null;

  const envFlag = process.env.BRAINSTORM_EMBEDDINGS;
  const envEnabled =
    opts.enabled ?? (envFlag === "1" || envFlag === "true" || envFlag === "on");
  if (!envEnabled) return null; // OFF by default

  const baseUrl =
    opts.baseUrl ??
    process.env.BRAINSTORM_EMBEDDINGS_BASE_URL ??
    "http://localhost:11434";
  const model =
    opts.model ?? process.env.BRAINSTORM_EMBEDDINGS_MODEL ?? "nomic-embed-text";

  return createOllamaEmbeddingProvider(baseUrl, model);
}

/**
 * Ollama-backed embedding provider. Prefers the batch `/api/embed` endpoint,
 * falling back to the legacy per-text `/api/embeddings` endpoint. All network
 * calls are time-bounded; callers wrap this in try/catch and degrade to TF-IDF
 * on any failure, so an unreachable Ollama never crashes a turn.
 */
export function createOllamaEmbeddingProvider(
  baseUrl = "http://localhost:11434",
  model = "nomic-embed-text",
): EmbeddingProvider {
  return {
    id: `ollama:${model}`,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      // Batch endpoint (Ollama >= 0.3).
      try {
        const res = await fetch(`${baseUrl}/api/embed`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, input: texts }),
          signal: AbortSignal.timeout(30_000),
        });
        if (res.ok) {
          const data = (await res.json()) as { embeddings?: number[][] };
          if (
            Array.isArray(data.embeddings) &&
            data.embeddings.length === texts.length
          ) {
            return data.embeddings;
          }
        }
      } catch {
        /* fall through to legacy per-text endpoint */
      }

      // Legacy single-prompt endpoint, one request per text.
      const out: number[][] = [];
      for (const text of texts) {
        const res = await fetch(`${baseUrl}/api/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, prompt: text }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
          throw new Error(`embedding request failed: ${res.status}`);
        }
        const data = (await res.json()) as { embedding?: number[] };
        if (!Array.isArray(data.embedding)) {
          throw new Error("embedding response missing 'embedding'");
        }
        out.push(data.embedding);
      }
      return out;
    },
  };
}

/** Cosine similarity between two dense vectors. */
export function denseCosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Content hash used as the cache key for a persisted embedding. */
export function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ── Persistence ──────────────────────────────────────────────────────
//
// Reuses the existing `code_embeddings` table (db migration 015). That table
// only shipped a `tfidf_vector TEXT` column, so we lazily widen it with the
// `model`/`content_hash`/`dim` columns needed for cache-invalidation — a real
// dense vector store keyed by (content_hash, model). Everything is wrapped so a
// missing/locked DB simply disables persistence rather than crashing.

export interface EmbeddingStoreRecord {
  projectPath: string;
  filePath: string;
  symbolName: string | null;
  snippet: string;
  hash: string;
  model: string;
  vector: number[];
}

export interface EmbeddingStore {
  get(hash: string, model: string): number[] | null;
  put(rec: EmbeddingStoreRecord): void;
}

let _storeReady = false;

function ensureStore(db: any): boolean {
  if (_storeReady) return true;
  try {
    const cols = db
      .prepare("PRAGMA table_info(code_embeddings)")
      .all() as Array<{ name: string }>;
    if (cols.length === 0) return false; // table not migrated yet
    const have = new Set(cols.map((c) => c.name));
    if (!have.has("model")) {
      db.exec("ALTER TABLE code_embeddings ADD COLUMN model TEXT");
    }
    if (!have.has("content_hash")) {
      db.exec("ALTER TABLE code_embeddings ADD COLUMN content_hash TEXT");
    }
    if (!have.has("dim")) {
      db.exec("ALTER TABLE code_embeddings ADD COLUMN dim INTEGER");
    }
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_embeddings_hash ON code_embeddings(content_hash, model)",
    );
    _storeReady = true;
    return true;
  } catch {
    return false;
  }
}

/**
 * Open the shared embedding store, or null if the DB is unavailable. Never
 * throws — persistence is a best-effort cache, not a hard dependency.
 */
export function openEmbeddingStore(): EmbeddingStore | null {
  let db: any;
  try {
    db = getDb();
  } catch {
    return null;
  }
  if (!db || !ensureStore(db)) return null;

  return {
    get(hash: string, model: string): number[] | null {
      try {
        const row = db
          .prepare(
            "SELECT tfidf_vector FROM code_embeddings WHERE content_hash = ? AND model = ? LIMIT 1",
          )
          .get(hash, model) as { tfidf_vector: string } | undefined;
        if (!row) return null;
        const v = JSON.parse(row.tfidf_vector);
        return Array.isArray(v) ? v : null;
      } catch {
        return null;
      }
    },
    put(rec: EmbeddingStoreRecord): void {
      try {
        db.prepare(
          `INSERT INTO code_embeddings
             (project_path, file_path, symbol_name, content_snippet, tfidf_vector, model, content_hash, dim)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          rec.projectPath,
          rec.filePath,
          rec.symbolName,
          rec.snippet,
          JSON.stringify(rec.vector),
          rec.model,
          rec.hash,
          rec.vector.length,
        );
      } catch {
        /* best-effort cache — ignore write failures */
      }
    },
  };
}

/** Test hook: reset the one-time schema-widening guard. */
export function _resetEmbeddingStoreForTests(): void {
  _storeReady = false;
}
