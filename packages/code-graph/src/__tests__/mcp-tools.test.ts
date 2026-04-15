import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodeGraph } from "../graph.js";
import { registerAdapter } from "../languages/registry.js";
import { createTypeScriptAdapter } from "../languages/typescript.js";
import { createPythonAdapter } from "../languages/python.js";
import { executePipeline, createDefaultPipeline } from "../pipeline/index.js";
import { registerCodeIntelTools } from "../mcp/tools.js";
import type { PipelineContext } from "../pipeline/types.js";

// Mock MCP server that captures registered tools
class MockMCPServer {
  tools = new Map<
    string,
    { description: string; handler: (params: any) => Promise<any> }
  >();

  tool(
    name: string,
    description: string,
    _schema: any,
    handler: (params: any) => Promise<any>,
  ) {
    this.tools.set(name, { description, handler });
  }

  async call(name: string, params: any = {}): Promise<any> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool '${name}' not registered`);
    const result = await tool.handler(params);
    return JSON.parse(result.content[0].text);
  }
}

let graph: CodeGraph;
let server: MockMCPServer;
let projectDir: string;

beforeAll(async () => {
  registerAdapter(createTypeScriptAdapter());
  registerAdapter(createPythonAdapter());

  // Create fixture project
  projectDir = join(tmpdir(), `mcp-test-${Date.now()}`);
  mkdirSync(join(projectDir, "src"), { recursive: true });
  mkdirSync(join(projectDir, "lib"), { recursive: true });

  writeFileSync(
    join(projectDir, "src", "auth.ts"),
    `
export function validateToken(token: string): boolean {
  return checkSignature(token);
}

function checkSignature(token: string): boolean {
  return token.startsWith("Bearer ");
}

export class AuthService {
  async verify(token: string): Promise<boolean> {
    return validateToken(token);
  }
}
`,
    "utf-8",
  );

  writeFileSync(
    join(projectDir, "src", "api.ts"),
    `
import { validateToken } from "./auth";

export function handleRequest(req: any) {
  const valid = validateToken(req.token);
  return sendResponse(valid);
}

function sendResponse(ok: boolean) {
  return { status: ok ? 200 : 401 };
}

export function healthCheck() {
  return { status: "ok" };
}
`,
    "utf-8",
  );

  writeFileSync(
    join(projectDir, "lib", "utils.py"),
    `
def process_data(data):
    return transform(data)

def transform(data):
    return data.upper()
`,
    "utf-8",
  );

  // Initialize .git for code_detect_changes
  const { execFileSync } = require("node:child_process");
  try {
    execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: projectDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], {
      cwd: projectDir,
      stdio: "ignore",
    });
  } catch {
    /* git may not be configured */
  }

  // Build graph via pipeline
  const dbDir = join(tmpdir(), `mcp-db-${Date.now()}`);
  mkdirSync(dbDir, { recursive: true });
  graph = new CodeGraph({ dbPath: join(dbDir, "test.db") });

  await executePipeline(createDefaultPipeline(), {
    projectPath: projectDir,
    graph,
    results: new Map(),
  });

  // Register tools
  server = new MockMCPServer();
  registerCodeIntelTools(server as any, graph, projectDir);
});

afterAll(() => {
  graph?.close();
});

describe("MCP Code Intelligence Tools", () => {
  it("registers all 16 tools", () => {
    expect(server.tools.size).toBe(16);
    expect(server.tools.has("code_query")).toBe(true);
    expect(server.tools.has("code_context")).toBe(true);
    expect(server.tools.has("code_callers")).toBe(true);
    expect(server.tools.has("code_callees")).toBe(true);
    expect(server.tools.has("code_impact")).toBe(true);
    expect(server.tools.has("code_search")).toBe(true);
    expect(server.tools.has("code_detect_changes")).toBe(true);
    expect(server.tools.has("code_rename")).toBe(true);
    expect(server.tools.has("code_graph_query")).toBe(true);
    expect(server.tools.has("code_communities")).toBe(true);
    expect(server.tools.has("code_community_detail")).toBe(true);
    expect(server.tools.has("code_file_summary")).toBe(true);
    expect(server.tools.has("code_dependencies")).toBe(true);
    expect(server.tools.has("code_hotspots")).toBe(true);
    expect(server.tools.has("code_stats")).toBe(true);
    expect(server.tools.has("code_reindex")).toBe(true);
  });

  it("code_query finds definitions", async () => {
    const result = await server.call("code_query", { name: "validateToken" });
    expect(result.count).toBeGreaterThan(0);
    expect(result.definitions[0].kind).toBe("function");
  });

  it("code_context returns source + callers + callees", async () => {
    const result = await server.call("code_context", { name: "validateToken" });
    expect(result.source).toContain("validateToken");
    expect(result.callerCount).toBeGreaterThan(0);
    expect(result.calleeCount).toBeGreaterThan(0);
  });

  it("code_callers finds direct callers", async () => {
    const result = await server.call("code_callers", { name: "validateToken" });
    expect(result.callers.length).toBeGreaterThan(0);
  });

  it("code_callers supports transitive depth", async () => {
    const result = await server.call("code_callers", {
      name: "checkSignature",
      depth: 3,
    });
    expect(result.transitive).toBe(true);
  });

  it("code_callees finds what a function calls", async () => {
    const result = await server.call("code_callees", { name: "handleRequest" });
    const names = result.callees.map((c: any) => c.callee ?? c.name);
    expect(names).toContain("validateToken");
  });

  it("code_impact shows blast radius", async () => {
    const result = await server.call("code_impact", { name: "checkSignature" });
    expect(result.totalAffected).toBeGreaterThan(0);
    expect(result.byDepth).toBeDefined();
  });

  it("code_search finds by keyword", async () => {
    const result = await server.call("code_search", { query: "validate" });
    expect(result.count).toBeGreaterThan(0);
    expect(result.results.some((r: any) => r.name.includes("validate"))).toBe(
      true,
    );
  });

  it("code_rename shows all references", async () => {
    const result = await server.call("code_rename", { name: "validateToken" });
    expect(result.totalReferences).toBeGreaterThan(0);
    expect(result.definitions.length).toBeGreaterThan(0);
    expect(result.callSites.length).toBeGreaterThan(0);
  });

  it("code_graph_query runs safe SQL", async () => {
    const result = await server.call("code_graph_query", {
      sql: "SELECT COUNT(*) AS total FROM nodes",
    });
    expect(result.results[0].total).toBeGreaterThan(0);
  });

  it("code_graph_query blocks mutations", async () => {
    const result = await server.call("code_graph_query", {
      sql: "DELETE FROM nodes",
    });
    expect(result.error).toContain("SELECT");
  });

  it("code_communities returns list (empty before Phase 2)", async () => {
    const result = await server.call("code_communities");
    expect(result.communities).toBeDefined();
    expect(Array.isArray(result.communities)).toBe(true);
  });

  it("code_file_summary shows file structure", async () => {
    const result = await server.call("code_file_summary", { file: "auth.ts" });
    expect(result.totalSymbols).toBeGreaterThan(0);
    expect(result.functions.length).toBeGreaterThan(0);
  });

  it("code_dependencies traces imports", async () => {
    const result = await server.call("code_dependencies", { file: "api.ts" });
    expect(result.imports.length).toBeGreaterThan(0);
  });

  it("code_hotspots finds most-called functions", async () => {
    const result = await server.call("code_hotspots", { limit: 5 });
    expect(result.hotspots.length).toBeGreaterThan(0);
    expect(result.hotspots[0].callerCount).toBeGreaterThan(0);
  });

  it("code_stats returns comprehensive graph stats", async () => {
    const result = await server.call("code_stats");
    expect(result.files).toBeGreaterThan(0);
    expect(result.nodes).toBeGreaterThan(0);
    expect(result.languages.length).toBeGreaterThan(0);
  });
});
