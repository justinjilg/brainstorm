import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CodeGraph } from "../graph.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";

describe("Enhanced graph schema", () => {
  let graph: CodeGraph;
  let dbPath: string;

  beforeEach(() => {
    const dir = join(
      tmpdir(),
      `graph-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, "test.db");
    graph = new CodeGraph({ dbPath });
  });

  afterEach(() => {
    graph.close();
  });

  function seedGraph() {
    const db = graph.getDb();
    const statements = [
      "INSERT INTO files (path, content_hash, last_parsed) VALUES ('src/auth.ts', 'abc123', 1000)",
      "INSERT INTO files (path, content_hash, last_parsed) VALUES ('src/api.ts', 'def456', 1000)",
      "INSERT INTO nodes (id, kind, name, file, start_line, end_line, language) VALUES ('n1', 'function', 'validateToken', 'src/auth.ts', 1, 10, 'typescript')",
      "INSERT INTO nodes (id, kind, name, file, start_line, end_line, language) VALUES ('n2', 'function', 'checkPermissions', 'src/auth.ts', 12, 20, 'typescript')",
      "INSERT INTO nodes (id, kind, name, file, start_line, end_line, language) VALUES ('n3', 'function', 'handleRequest', 'src/api.ts', 1, 30, 'typescript')",
      "INSERT INTO nodes (id, kind, name, file, start_line, end_line, language) VALUES ('n4', 'function', 'processPayload', 'src/api.ts', 32, 50, 'typescript')",
      "INSERT INTO nodes (id, kind, name, file, start_line, end_line, language) VALUES ('n5', 'function', 'sendResponse', 'src/api.ts', 52, 60, 'typescript')",
      "INSERT INTO edges (source_id, target_id, kind) VALUES ('n3', 'n1', 'calls')",
      "INSERT INTO edges (source_id, target_id, kind) VALUES ('n3', 'n2', 'calls')",
      "INSERT INTO edges (source_id, target_id, kind) VALUES ('n3', 'n4', 'calls')",
      "INSERT INTO edges (source_id, target_id, kind) VALUES ('n4', 'n5', 'calls')",
      "INSERT INTO edges (source_id, target_id, kind) VALUES ('n2', 'n1', 'calls')",
    ];
    for (const sql of statements) {
      db.prepare(sql).run();
    }
  }

  describe("transitiveCallers", () => {
    it("finds all transitive callers via recursive CTE", () => {
      seedGraph();
      const callers = graph.transitiveCallers("n1", 5);
      const names = callers.map((c) => c.name);
      expect(names).toContain("checkPermissions");
      expect(names).toContain("handleRequest");
      expect(callers.length).toBeGreaterThanOrEqual(2);
    });

    it("respects maxDepth", () => {
      seedGraph();
      const callers = graph.transitiveCallers("n5", 1);
      const names = callers.map((c) => c.name);
      expect(names).toContain("processPayload");
      expect(names).not.toContain("handleRequest");
    });
  });

  describe("transitiveCallees", () => {
    it("finds all transitive callees", () => {
      seedGraph();
      const callees = graph.transitiveCallees("n3", 5);
      const names = callees.map((c) => c.name);
      expect(names).toContain("validateToken");
      expect(names).toContain("checkPermissions");
      expect(names).toContain("processPayload");
      expect(names).toContain("sendResponse");
    });
  });

  describe("shortestPath", () => {
    it("finds path between connected nodes", () => {
      seedGraph();
      const path = graph.shortestPath("n3", "n5");
      expect(path).not.toBeNull();
      expect(path![0]).toBe("n3");
      expect(path![path!.length - 1]).toBe("n5");
    });

    it("returns null for disconnected nodes", () => {
      seedGraph();
      const path = graph.shortestPath("n5", "n3");
      expect(path).toBeNull();
    });
  });

  describe("connectedComponent", () => {
    it("finds all connected nodes", () => {
      seedGraph();
      const component = graph.connectedComponent("n1");
      expect(component.length).toBe(5);
    });
  });

  describe("communities", () => {
    it("returns empty when no communities assigned", () => {
      seedGraph();
      expect(graph.getCommunities()).toEqual([]);
    });

    it("returns nodes in a community", () => {
      seedGraph();
      const db = graph.getDb();
      db.prepare(
        "INSERT INTO communities (id, name, node_count, complexity_score) VALUES ('c1', 'auth', 2, 3.5)",
      ).run();
      db.prepare(
        "UPDATE nodes SET community_id = 'c1' WHERE id IN ('n1', 'n2')",
      ).run();

      const communities = graph.getCommunities();
      expect(communities).toHaveLength(1);
      expect(communities[0].name).toBe("auth");

      const nodes = graph.getNodesInCommunity("c1");
      expect(nodes).toHaveLength(2);
      const names = nodes.map((n) => n.name);
      expect(names).toContain("validateToken");
      expect(names).toContain("checkPermissions");
    });
  });

  describe("extendedStats", () => {
    it("includes node and edge counts", () => {
      seedGraph();
      const stats = graph.extendedStats();
      expect(stats.nodes).toBe(5);
      expect(stats.graphEdges).toBe(5);
      expect(stats.communities).toBe(0);
      expect(stats.files).toBe(2);
    });
  });

  describe("findNode", () => {
    it("finds nodes by name", () => {
      seedGraph();
      const results = graph.findNode("validateToken");
      expect(results).toHaveLength(1);
      expect(results[0].kind).toBe("function");
      expect(results[0].file).toBe("src/auth.ts");
    });
  });
});
