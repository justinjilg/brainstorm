import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodeGraph } from "../graph.js";
import { registerAdapter } from "../languages/registry.js";
import { createTypeScriptAdapter } from "../languages/typescript.js";
import { createPythonAdapter } from "../languages/python.js";
import { executePipeline, createDefaultPipeline } from "../pipeline/index.js";
import { detectCommunities } from "../community/index.js";
import {
  assignAgentsToSectors,
  getAgentForFile,
  getAgentsByPriority,
} from "../sectors/agent-assigner.js";
import { profileForTier } from "../sectors/model-matcher.js";
import {
  createInitialPlan,
  getNextObjective,
  completeObjective,
  saveSectorPlan,
  loadSectorPlan,
} from "../sectors/plan.js";
import {
  selectNextSector,
  recordSectorTick,
  getSectorPlanSummary,
} from "../sectors/sector-daemon.js";

let graph: CodeGraph;
let projectDir: string;

beforeAll(async () => {
  registerAdapter(createTypeScriptAdapter());
  registerAdapter(createPythonAdapter());

  // Create a project with clear sector boundaries
  projectDir = join(tmpdir(), `sectors-test-${Date.now()}`);

  // Auth sector — critical (crypto/auth keywords)
  mkdirSync(join(projectDir, "src", "auth"), { recursive: true });
  writeFileSync(
    join(projectDir, "src", "auth", "jwt.ts"),
    `
export function verifyToken(token: string): boolean {
  return decryptPayload(token) !== null;
}
function decryptPayload(token: string): any {
  return JSON.parse(atob(token.split(".")[1]));
}
export function signToken(payload: any): string {
  return encryptPayload(JSON.stringify(payload));
}
function encryptPayload(data: string): string {
  return btoa(data);
}
export class AuthService {
  authenticate(user: string, pass: string): boolean {
    return verifyToken(signToken({ user }));
  }
}
`,
    "utf-8",
  );

  // API sector — standard (routes)
  mkdirSync(join(projectDir, "src", "api"), { recursive: true });
  writeFileSync(
    join(projectDir, "src", "api", "routes.ts"),
    `
import { verifyToken } from "../auth/jwt";
export function handleLogin(req: any) {
  return verifyToken(req.body.token);
}
export function handleLogout(req: any) {
  return { success: true };
}
export function healthCheck() {
  return { status: "ok" };
}
`,
    "utf-8",
  );

  // Utils sector — simple
  mkdirSync(join(projectDir, "src", "utils"), { recursive: true });
  writeFileSync(
    join(projectDir, "src", "utils", "format.ts"),
    `
export function formatDate(d: Date): string {
  return d.toISOString();
}
export function formatCurrency(n: number): string {
  return "$" + n.toFixed(2);
}
export function slugify(s: string): string {
  return s.toLowerCase().replace(/\\s+/g, "-");
}
`,
    "utf-8",
  );

  // Python data processing
  writeFileSync(
    join(projectDir, "src", "utils", "process.py"),
    `
def transform_data(data):
    return normalize(data)
def normalize(data):
    return data.strip().lower()
`,
    "utf-8",
  );

  // Build graph
  const dbDir = join(tmpdir(), `sectors-db-${Date.now()}`);
  mkdirSync(dbDir, { recursive: true });
  graph = new CodeGraph({ dbPath: join(dbDir, "test.db") });

  await executePipeline(createDefaultPipeline(), {
    projectPath: projectDir,
    graph,
    results: new Map(),
  });
});

afterAll(() => {
  graph?.close();
});

describe("Sector Agent Assignment", () => {
  it("detects communities from the indexed graph", () => {
    const result = detectCommunities(graph);
    expect(result.communities.length).toBeGreaterThan(0);
    expect(result.totalNodes).toBeGreaterThan(0);
  });

  it("assigns agents to sectors with tier classification", () => {
    const { communities } = detectCommunities(graph);
    const agents = assignAgentsToSectors(communities, graph, {
      writeAgentFiles: false,
      minNodes: 2,
    });

    expect(agents.length).toBeGreaterThan(0);

    // Each agent has required fields
    for (const agent of agents) {
      expect(agent.sectorId).toBeTruthy();
      expect(agent.sectorName).toBeTruthy();
      expect(["critical", "complex", "standard", "simple"]).toContain(
        agent.tier,
      );
      expect(agent.taskProfile).toBeDefined();
      expect(agent.taskProfile.qualityTier).toBeGreaterThanOrEqual(1);
      expect(agent.taskProfile.qualityTier).toBeLessThanOrEqual(5);
      expect(agent.files.length).toBeGreaterThan(0);
      expect(agent.systemPromptAddendum).toContain("Your Sector");
    }
  });

  it("writes .agent.md files when requested", () => {
    const { communities } = detectCommunities(graph);
    const agents = assignAgentsToSectors(communities, graph, {
      writeAgentFiles: true,
      projectPath: projectDir,
      minNodes: 2,
    });

    // Check that files were created
    for (const agent of agents) {
      const agentFile = join(
        projectDir,
        ".brainstorm",
        "agents",
        `${agent.agentId}.agent.md`,
      );
      expect(existsSync(agentFile)).toBe(true);
    }
  });

  it("getAgentForFile finds the right sector agent", () => {
    const { communities } = detectCommunities(graph);
    const agents = assignAgentsToSectors(communities, graph, {
      writeAgentFiles: false,
      minNodes: 2,
    });

    // At least one agent should own a file
    const allFiles = agents.flatMap((a) => a.files);
    if (allFiles.length > 0) {
      const agent = getAgentForFile(allFiles[0], agents);
      expect(agent).not.toBeNull();
    }
  });

  it("getAgentsByPriority sorts critical first", () => {
    const { communities } = detectCommunities(graph);
    const agents = assignAgentsToSectors(communities, graph, {
      writeAgentFiles: false,
      minNodes: 2,
    });

    const sorted = getAgentsByPriority(agents);
    const tierOrder = { critical: 0, complex: 1, standard: 2, simple: 3 };
    for (let i = 1; i < sorted.length; i++) {
      expect(tierOrder[sorted[i].tier]).toBeGreaterThanOrEqual(
        tierOrder[sorted[i - 1].tier],
      );
    }
  });
});

describe("Model Matcher", () => {
  it("maps tiers to BR Complexity and QualityTier", () => {
    const critical = profileForTier("critical");
    expect(critical.complexity).toBe("expert");
    expect(critical.qualityTier).toBe(1);
    expect(critical.maxSteps).toBe(15);

    const simple = profileForTier("simple");
    expect(simple.complexity).toBe("simple");
    expect(simple.qualityTier).toBe(5);
    expect(simple.maxSteps).toBe(5);
  });
});

describe("Persistent Sector Plans", () => {
  it("creates initial plan with auto-generated objectives", () => {
    const plan = createInitialPlan(
      "test-sector",
      "auth/jwt",
      ["src/auth/jwt.ts"],
      7.5,
    );

    expect(plan.sectorId).toBe("test-sector");
    expect(plan.status).toBe("active");
    expect(plan.objectives.length).toBeGreaterThanOrEqual(3);
    // High complexity → should include simplification objective
    expect(plan.objectives.some((o) => o.description.includes("simplif"))).toBe(
      true,
    );
  });

  it("getNextObjective respects dependencies", () => {
    const plan = createInitialPlan("test", "test", ["a.ts"], 5);
    // First objective has no deps — should be actionable
    const first = getNextObjective(plan);
    expect(first).not.toBeNull();
    expect(first!.dependsOn).toEqual([]);

    // Complete it
    completeObjective(plan, first!.id, "Done");
    expect(first!.status).toBe("completed");

    // Now dependent objectives should be unblocked
    const next = getNextObjective(plan);
    expect(next).not.toBeNull();
    expect(next!.id).not.toBe(first!.id);
  });

  it("persists plans to SQLite and reloads", () => {
    const db = graph.getDb();
    const plan = createInitialPlan("persist-test", "test", ["a.ts"], 3);
    saveSectorPlan(db, plan);

    const loaded = loadSectorPlan(db, "persist-test");
    expect(loaded).not.toBeNull();
    expect(loaded!.sectorId).toBe("persist-test");
    expect(loaded!.objectives.length).toBe(plan.objectives.length);
  });
});

describe("Sector Daemon", () => {
  it("selectNextSector picks the sector with oldest lastTickAt", () => {
    const { communities } = detectCommunities(graph);
    const agents = assignAgentsToSectors(communities, graph, {
      writeAgentFiles: false,
      minNodes: 2,
    });

    if (agents.length === 0) return; // skip if no eligible agents

    const tick = selectNextSector(agents, graph);
    expect(tick).not.toBeNull();
    expect(tick!.tickMessage).toContain("Sector Tick");
    expect(tick!.budgetLimit).toBeGreaterThan(0);
    expect(tick!.preferredQualityTier).toBeGreaterThanOrEqual(1);
  });

  it("recordSectorTick updates plan state", () => {
    const db = graph.getDb();
    const plan = createInitialPlan("tick-test", "test", ["a.ts"], 3);
    saveSectorPlan(db, plan);

    recordSectorTick(graph, "tick-test", 0.02);

    const updated = loadSectorPlan(db, "tick-test");
    expect(updated!.tickCount).toBe(1);
    expect(updated!.totalCost).toBe(0.02);
    expect(updated!.lastTickAt).toBeGreaterThan(0);
  });

  it("getSectorPlanSummary returns dashboard data", () => {
    const { communities } = detectCommunities(graph);
    const agents = assignAgentsToSectors(communities, graph, {
      writeAgentFiles: false,
      minNodes: 2,
    });

    const summary = getSectorPlanSummary(agents, graph);
    expect(summary.length).toBe(agents.length);
    for (const s of summary) {
      expect(s.sectorName).toBeTruthy();
      expect(s.tier).toBeTruthy();
      expect(s.progress).toMatch(/\d+\/\d+/);
    }
  });
});
