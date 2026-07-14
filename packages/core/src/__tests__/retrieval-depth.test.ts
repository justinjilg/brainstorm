import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingProvider, EmbeddingStore } from "../search/embeddings";

/**
 * Phase 4 — retrieval depth.
 *
 *  A) Real embedding backend behind the TF-IDF seam (semanticSearchEmbedded):
 *     - with a backend, it's used; with none, it falls back to TF-IDF (no throw).
 *  B) Code-graph fusion in buildSystemPrompt:
 *     - moderate/complex tasks get a bounded block in the DYNAMIC segment;
 *     - trivial tasks get none; the block never lands in the cached prefix;
 *     - the block respects the char/K cap.
 */

// ── Fixture project: two small files with distinct topics ────────────
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "retr-depth-"));
  const src = join(dir, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(
    join(src, "auth.ts"),
    `// user authentication and login handling
export function loginUser(username: string, password: string) {
  // authenticate the user credentials and issue a session token
  return { token: "abc", username };
}
export function logoutUser(token: string) {
  return true;
}
`,
  );
  writeFileSync(
    join(src, "database.ts"),
    `// sqlite database queries and persistence
export function runQuery(sql: string) {
  // execute a raw sql query against the database
  return [];
}
export function migrateSchema() {
  return true;
}
`,
  );
  // findSourceFiles uses `git ls-files`, so the fixture must be a git repo.
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

/**
 * Keyword-driven embedding provider: auth-ish text → [1,0], db-ish → [0,1],
 * else → [0.5,0.5]. Lets us assert the embedding backend drives ranking.
 */
function makeKeywordProvider(): EmbeddingProvider & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    id: "test:keyword",
    calls,
    async embed(texts: string[]): Promise<number[][]> {
      calls.push(texts);
      return texts.map((t) => {
        const lc = t.toLowerCase();
        const auth = /login|auth|user|password|token|session/.test(lc);
        const db = /sql|database|query|migrate|persist/.test(lc);
        if (auth && !db) return [1, 0];
        if (db && !auth) return [0, 1];
        return [0.5, 0.5];
      });
    },
  };
}

describe("Deliverable A — embedding backend behind TF-IDF seam", () => {
  let fixture: string;
  beforeEach(() => {
    fixture = makeFixture();
  });
  afterEach(() => {
    rmSync(fixture, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("uses the injected embedding backend for ranking", async () => {
    const { semanticSearchEmbedded } = await import("../search/semantic");
    const provider = makeKeywordProvider();

    const results = await semanticSearchEmbedded(
      "user login authentication",
      fixture,
      10,
      { provider, store: null },
    );

    // Backend was invoked (docs + query).
    expect(provider.calls.length).toBeGreaterThan(0);
    expect(results.length).toBeGreaterThan(0);
    // Auth-topic query → auth.ts ranks first (dense cosine, not TF-IDF).
    expect(results[0].filePath).toContain("auth");
  });

  it("falls back to TF-IDF with no throw when no backend is configured", async () => {
    const { semanticSearchEmbedded, semanticSearch } =
      await import("../search/semantic");

    // provider: null explicitly forces the fallback path.
    const embedded = await semanticSearchEmbedded(
      "run query sql",
      fixture,
      10,
      {
        provider: null,
      },
    );
    const tfidf = semanticSearch("run query sql", fixture, 10);

    expect(Array.isArray(embedded)).toBe(true);
    // Falls back to exactly the TF-IDF result set.
    expect(embedded.map((r) => r.filePath + r.symbolName)).toEqual(
      tfidf.map((r) => r.filePath + r.symbolName),
    );
  });

  it("resolveEmbeddingProvider is OFF by default (no env)", async () => {
    const { resolveEmbeddingProvider } = await import("../search/embeddings");
    const prev = process.env.BRAINSTORM_EMBEDDINGS;
    delete process.env.BRAINSTORM_EMBEDDINGS;
    try {
      expect(resolveEmbeddingProvider()).toBeNull();
    } finally {
      if (prev !== undefined) process.env.BRAINSTORM_EMBEDDINGS = prev;
    }
  });

  it("never throws when the backend fails — degrades to TF-IDF", async () => {
    const { semanticSearchEmbedded } = await import("../search/semantic");
    const exploding: EmbeddingProvider = {
      id: "test:boom",
      async embed() {
        throw new Error("backend unreachable");
      },
    };

    const results = await semanticSearchEmbedded("login user", fixture, 10, {
      provider: exploding,
      store: null,
    });
    // No throw; TF-IDF results returned instead.
    expect(Array.isArray(results)).toBe(true);
  });

  it("persists embeddings and reuses the cache on the second call", async () => {
    const { semanticSearchEmbedded } = await import("../search/semantic");
    const provider = makeKeywordProvider();

    // Simple in-memory store standing in for code_embeddings.
    const map = new Map<string, number[]>();
    const store: EmbeddingStore = {
      get: (hash, model) => map.get(`${model}:${hash}`) ?? null,
      put: (rec) => {
        map.set(`${rec.model}:${rec.hash}`, rec.vector);
      },
    };

    await semanticSearchEmbedded("login user", fixture, 10, {
      provider,
      store,
    });
    const docCallsFirst = provider.calls.length;
    expect(map.size).toBeGreaterThan(0); // docs persisted

    // Second call: doc embeddings served from cache, only the query is embedded.
    const before = provider.calls.length;
    await semanticSearchEmbedded("login user", fixture, 10, {
      provider,
      store,
    });
    const newCalls = provider.calls.slice(before);
    // Every new call this round is just the single-element query batch.
    for (const batch of newCalls) {
      expect(batch.length).toBe(1);
    }
    expect(docCallsFirst).toBeGreaterThan(0);
  });
});

describe("Deliverable B — code-graph fusion in the dynamic segment", () => {
  const fakeSymbols = Array.from({ length: 40 }, (_, i) => ({
    file: `src/module${i}.ts`,
    name: `handlerFunctionNumber${i}`,
    kind: "function",
    line: i + 1,
    signature: `function handlerFunctionNumber${i}(a: string, b: number): Promise<void>`,
  }));

  const retrieveMany = () => fakeSymbols;
  const BLOCK_HEADER = "Relevant Code (retrieved via code-graph)";

  it("moderate task gets a bounded code-graph block in the DYNAMIC segment", async () => {
    const { buildSystemPrompt } = await import("../agent/context");

    const result = buildSystemPrompt(
      process.cwd(),
      undefined,
      undefined,
      "moderate",
      { taskText: "refactor the auth handler", retrieve: retrieveMany },
    );

    const [cached, dynamic] = result.segments;
    expect(dynamic.cacheable).toBe(false);
    expect(dynamic.text).toContain(BLOCK_HEADER);
    // HARD CONSTRAINT: never in the cached prefix.
    expect(cached.cacheable).toBe(true);
    expect(cached.text).not.toContain(BLOCK_HEADER);
  });

  it("trivial task gets NO retrieval block", async () => {
    const { buildSystemPrompt } = await import("../agent/context");

    const result = buildSystemPrompt(
      process.cwd(),
      undefined,
      undefined,
      "trivial",
      { taskText: "refactor the auth handler", retrieve: retrieveMany },
    );

    for (const seg of result.segments) {
      expect(seg.text).not.toContain(BLOCK_HEADER);
    }
  });

  it("no taskText → no block even at moderate complexity", async () => {
    const { buildSystemPrompt } = await import("../agent/context");
    const result = buildSystemPrompt(
      process.cwd(),
      undefined,
      undefined,
      "moderate",
      {
        retrieve: retrieveMany,
      },
    );
    for (const seg of result.segments) {
      expect(seg.text).not.toContain(BLOCK_HEADER);
    }
  });

  it("respects the char cap and top-K", async () => {
    const { buildCodeGraphBlock } = await import("../agent/context");

    const charCap = 200;
    const block = buildCodeGraphBlock(process.cwd(), {
      taskText: "anything",
      retrieve: retrieveMany,
      topK: 40,
      charCap,
    });

    expect(block).toBeTruthy();
    // The symbol list (everything after the fixed header/intro) is <= charCap.
    const listBody = block!.split("Read these before editing.\n")[1] ?? "";
    expect(listBody.length).toBeLessThanOrEqual(charCap);
    // And far fewer than the 40 candidates fit under a 200-char cap.
    const lineCount = listBody.split("\n").filter(Boolean).length;
    expect(lineCount).toBeLessThan(40);
    expect(lineCount).toBeGreaterThan(0);
  });

  it("respects top-K even when the cap is generous", async () => {
    const { buildCodeGraphBlock } = await import("../agent/context");
    const block = buildCodeGraphBlock(process.cwd(), {
      taskText: "anything",
      retrieve: retrieveMany,
      topK: 5,
      charCap: 100_000,
    });
    const listBody = block!.split("Read these before editing.\n")[1] ?? "";
    const lineCount = listBody.split("\n").filter(Boolean).length;
    expect(lineCount).toBe(5);
  });

  it("no graph / empty retrieval → null block, no crash", async () => {
    const { buildCodeGraphBlock } = await import("../agent/context");
    expect(
      buildCodeGraphBlock(process.cwd(), {
        taskText: "x",
        retrieve: () => null,
      }),
    ).toBeNull();
    expect(
      buildCodeGraphBlock(process.cwd(), {
        taskText: "x",
        retrieve: () => {
          throw new Error("no graph db");
        },
      }),
    ).toBeNull();
  });
});
