import { describe, it, expect } from "vitest";

/**
 * Semantic search and context lineage tests.
 * Tests TF-IDF search, commit indexing, and search ranking
 * without requiring external services.
 */

describe("Semantic Search (TF-IDF)", () => {
  it("semanticSearch returns results for matching queries", async () => {
    const { semanticSearch } = await import("../search/semantic");

    // Search the brainstorm project itself
    const results = semanticSearch("router strategy", process.cwd());

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty("filePath");
    expect(results[0]).toHaveProperty("score");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("semanticSearch returns few/no results for nonsense queries", async () => {
    const { semanticSearch } = await import("../search/semantic");

    const results = semanticSearch("zzzzqqqxxx", process.cwd());
    // Nonsense queries should return very few or no results
    expect(results.length).toBeLessThan(3);
  });

  it("indexProject indexes files from the repo map", async () => {
    const { indexProject } = await import("../search/semantic");

    const { docs, idf } = indexProject(process.cwd());

    expect(docs.length).toBeGreaterThan(0);
    expect(idf.size).toBeGreaterThan(0);
  });

  it("results are ranked by relevance", async () => {
    const { semanticSearch } = await import("../search/semantic");

    const results = semanticSearch("cost tracker budget", process.cwd());

    if (results.length >= 2) {
      expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    }
  });
});

describe("Context Lineage (Git History)", () => {
  it("indexRecentCommits returns commit summaries", async () => {
    const { indexRecentCommits } = await import("../search/lineage");

    const commits = indexRecentCommits(process.cwd(), 10);

    expect(commits.length).toBeGreaterThan(0);
    expect(commits[0]).toHaveProperty("hash");
    expect(commits[0]).toHaveProperty("message");
    expect(commits[0]).toHaveProperty("summary");
    expect(commits[0].hash.length).toBe(8);
  });

  it("searchCommitHistory finds matching commits", async () => {
    const { searchCommitHistory } = await import("../search/lineage");

    // Use a broad term that exists in any git repo's history
    const results = searchCommitHistory("fix", process.cwd());

    // In CI shallow clones, results may be empty — that's OK
    // The function should at least not throw
    expect(Array.isArray(results)).toBe(true);
    if (results.length > 0) {
      expect(results[0].message.toLowerCase()).toContain("fix");
    }
  });

  it("searchCommitHistory returns empty for no matches", async () => {
    const { searchCommitHistory } = await import("../search/lineage");

    const results = searchCommitHistory("zzzzqqqxxx", process.cwd());
    expect(results.length).toBe(0);
  });

  it("formatCommitContext returns formatted string", async () => {
    const { formatCommitContext } = await import("../search/lineage");

    const context = formatCommitContext(process.cwd(), 3);

    expect(context).toBeTruthy();
    expect(context!.split("\n").length).toBeLessThanOrEqual(3);
    expect(context).toContain("-");
  });

  it("commit summaries include type detection", async () => {
    const { indexRecentCommits } = await import("../search/lineage");

    const commits = indexRecentCommits(process.cwd(), 10);
    const featCommit = commits.find((c) => c.message.startsWith("feat:"));

    if (featCommit) {
      expect(featCommit.summary).toMatch(/^feat/);
    }
  });
});
