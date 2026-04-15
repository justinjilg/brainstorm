import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodeGraph } from "../graph.js";
import { registerAdapter } from "../languages/registry.js";
import { createTypeScriptAdapter } from "../languages/typescript.js";
import { executePipeline, createDefaultPipeline } from "../pipeline/index.js";
import { CrossProjectGraph } from "../cross-project/index.js";
import { detectSharedTypes } from "../cross-project/shared-types.js";

let graphA: CodeGraph;
let graphB: CodeGraph;
let crossGraph: CrossProjectGraph;

beforeAll(async () => {
  registerAdapter(createTypeScriptAdapter());

  // Project A — a backend API
  const projectA = join(tmpdir(), `cross-a-${Date.now()}`);
  mkdirSync(join(projectA, "src"), { recursive: true });
  writeFileSync(
    join(projectA, "src", "server.ts"),
    `
import { UserService } from "./user-service";
export function handleGetUsers(req: any) {
  const service = new UserService();
  return service.listAll();
}
export function handleCreateUser(req: any) {
  const service = new UserService();
  return service.create(req.body);
}
export class ApiResponse {
  status: number;
  data: any;
}
`,
    "utf-8",
  );
  writeFileSync(
    join(projectA, "src", "user-service.ts"),
    `
export class UserService {
  listAll() { return []; }
  create(data: any) { return data; }
}
export class User {
  id: string;
  name: string;
}
`,
    "utf-8",
  );

  // Project B — a frontend that calls Project A
  const projectB = join(tmpdir(), `cross-b-${Date.now()}`);
  mkdirSync(join(projectB, "src"), { recursive: true });
  writeFileSync(
    join(projectB, "src", "client.ts"),
    `
export class ApiResponse {
  status: number;
  data: any;
}
export class User {
  id: string;
  name: string;
}
export function fetchGetUsers() {
  return fetch("/api/users");
}
export function fetchCreateUser(data: any) {
  return fetch("/api/users", { method: "POST", body: JSON.stringify(data) });
}
`,
    "utf-8",
  );

  // Build graphs
  const dbDirA = join(tmpdir(), `cross-db-a-${Date.now()}`);
  const dbDirB = join(tmpdir(), `cross-db-b-${Date.now()}`);
  mkdirSync(dbDirA, { recursive: true });
  mkdirSync(dbDirB, { recursive: true });

  graphA = new CodeGraph({ dbPath: join(dbDirA, "a.db") });
  graphB = new CodeGraph({ dbPath: join(dbDirB, "b.db") });

  await executePipeline(createDefaultPipeline(), {
    projectPath: projectA,
    graph: graphA,
    results: new Map(),
  });
  await executePipeline(createDefaultPipeline(), {
    projectPath: projectB,
    graph: graphB,
    results: new Map(),
  });

  // Create cross-project graph
  const crossDbDir = join(tmpdir(), `cross-db-${Date.now()}`);
  mkdirSync(crossDbDir, { recursive: true });
  crossGraph = new CrossProjectGraph(join(crossDbDir, "cross.db"));
  crossGraph.addProject("backend", graphA);
  crossGraph.addProject("frontend", graphB);
});

afterAll(() => {
  graphA?.close();
  graphB?.close();
  crossGraph?.close();
});

describe("Cross-Project Intelligence", () => {
  it("detects shared types across projects", () => {
    const sharedTypes = detectSharedTypes([
      { project: "backend", db: graphA.getDb() },
      { project: "frontend", db: graphB.getDb() },
    ]);

    // Both projects have ApiResponse and User
    const sharedNames = sharedTypes.map((t) => t.name);
    expect(sharedNames).toContain("ApiResponse");
    expect(sharedNames).toContain("User");

    // Each shared type should appear in both projects
    for (const st of sharedTypes) {
      expect(st.projects.length).toBeGreaterThanOrEqual(2);
      const projectNames = st.projects.map((p) => p.project);
      expect(projectNames).toContain("backend");
      expect(projectNames).toContain("frontend");
    }
  });

  it("runs full cross-project analysis", () => {
    const result = crossGraph.analyze();

    expect(result.projects).toContain("backend");
    expect(result.projects).toContain("frontend");
    expect(result.sharedTypes.length).toBeGreaterThan(0);

    // Edges should include shared type connections
    const typeEdges = result.edges.filter((e) => e.kind === "shared_type");
    expect(typeEdges.length).toBeGreaterThan(0);
  });

  it("persists and retrieves edges", () => {
    // analyze() was called in the previous test — edges should be persisted
    const backendDeps = crossGraph.getDependencies("backend");
    expect(backendDeps.length).toBeGreaterThan(0);

    const allEdges = crossGraph.getAllEdges();
    expect(allEdges.length).toBeGreaterThan(0);

    // Every edge should have the required fields
    for (const edge of allEdges) {
      expect(edge.sourceProject).toBeTruthy();
      expect(edge.targetProject).toBeTruthy();
      expect(edge.kind).toBeTruthy();
      expect(edge.confidence).toBeGreaterThan(0);
    }
  });
});
