/**
 * SDK tests — validates the Brainstorm class initialization and methods.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dependencies before importing the SDK
const mockLoadConfig = vi.fn();
const mockGetDb = vi.fn();
const mockCloseDb = vi.fn();
const mockCreateProviderRegistry = vi.fn();
const mockBrainstormRouter = vi.fn();
const mockCostTracker = vi.fn();
const mockRunAgentLoop = vi.fn();
const mockBuildSystemPrompt = vi.fn();
const mockSessionManager = vi.fn();
const mockCreateDefaultToolRegistry = vi.fn();
const mockAnalyzeProject = vi.fn();
const mockGenerateAllDocs = vi.fn();

vi.mock("@brainst0rm/config", () => ({
  loadConfig: mockLoadConfig,
}));

vi.mock("@brainst0rm/db", () => ({
  getDb: mockGetDb,
  closeDb: mockCloseDb,
}));

vi.mock("@brainst0rm/providers", () => ({
  createProviderRegistry: mockCreateProviderRegistry,
}));

vi.mock("@brainst0rm/router", () => ({
  BrainstormRouter: mockBrainstormRouter,
  CostTracker: mockCostTracker,
}));

vi.mock("@brainst0rm/core", () => ({
  runAgentLoop: mockRunAgentLoop,
  buildSystemPrompt: mockBuildSystemPrompt,
  SessionManager: mockSessionManager,
}));

vi.mock("@brainst0rm/tools", () => ({
  createDefaultToolRegistry: mockCreateDefaultToolRegistry,
}));

vi.mock("@brainst0rm/ingest", () => ({
  analyzeProject: mockAnalyzeProject,
}));

vi.mock("@brainst0rm/docgen", () => ({
  generateAllDocs: mockGenerateAllDocs,
}));

describe("SDK", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Default mock implementations
    mockLoadConfig.mockReturnValue({
      budget: { daily: 10, monthly: 100 },
    });
    mockGetDb.mockReturnValue({});
    mockCreateProviderRegistry.mockResolvedValue({});
    mockCreateDefaultToolRegistry.mockReturnValue({});
    mockAnalyzeProject.mockReturnValue({ files: [], imports: [] });
    mockGenerateAllDocs.mockReturnValue({ files: [], count: 0 });

    // Mock SessionManager
    const mockSession = { id: "test-session-123" };
    mockSessionManager.mockImplementation(() => ({
      start: vi.fn().mockReturnValue(mockSession),
      addUserMessage: vi.fn(),
      getHistory: vi.fn().mockReturnValue([]),
    }));

    // Mock CostTracker
    mockCostTracker.mockImplementation(() => ({
      getSessionCost: vi.fn().mockReturnValue(0.005),
    }));

    // Mock BrainstormRouter
    mockBrainstormRouter.mockImplementation(() => ({
      setStrategy: vi.fn(),
      classify: vi.fn().mockReturnValue({
        type: "code",
        complexity: "medium",
      }),
      route: vi.fn().mockReturnValue({
        model: { name: "gpt-4" },
        strategy: "quality-first",
        reason: "Complex code task",
      }),
    }));

    // Mock buildSystemPrompt
    mockBuildSystemPrompt.mockReturnValue({
      prompt: "System prompt content",
      frontmatter: { role: "assistant" },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exports Brainstorm class", async () => {
    const mod = await import("../index.js");
    expect(mod.Brainstorm).toBeDefined();
    expect(typeof mod.Brainstorm).toBe("function");
  });

  it("Brainstorm class has run method", async () => {
    const { Brainstorm } = await import("../index.js");
    expect(typeof Brainstorm.prototype.run).toBe("function");
  });

  describe("initialization", () => {
    it("initializes with default options", async () => {
      const { Brainstorm } = await import("../index.js");
      const bs = new Brainstorm();

      expect(mockLoadConfig).toHaveBeenCalled();
      expect(bs).toBeInstanceOf(Brainstorm);
    });

    it("initializes with custom projectPath", async () => {
      const { Brainstorm } = await import("../index.js");
      const customPath = "/custom/project/path";
      const bs = new Brainstorm({ projectPath: customPath });

      expect(bs).toBeInstanceOf(Brainstorm);
      // The projectPath is stored but loadConfig is called without args
      expect(mockLoadConfig).toHaveBeenCalled();
    });

    it("initializes with all options", async () => {
      const { Brainstorm } = await import("../index.js");
      const options = {
        projectPath: "/test/path",
        strategy: "cost-first" as const,
        model: "claude-3-opus",
        maxSteps: 5,
        tools: false,
        budget: 50,
        apiKeys: { OPENAI_API_KEY: "sk-test123" },
      };

      const bs = new Brainstorm(options);
      expect(bs).toBeInstanceOf(Brainstorm);
    });
  });

  describe("analyze()", () => {
    it("calls analyzeProject with projectPath from options", async () => {
      const { Brainstorm } = await import("../index.js");
      const customPath = "/my/project";
      const mockAnalysis = {
        files: ["src/index.ts"],
        imports: [{ from: "react", to: "src/app.tsx" }],
      };
      mockAnalyzeProject.mockReturnValue(mockAnalysis);

      const bs = new Brainstorm({ projectPath: customPath });
      const result = bs.analyze();

      expect(mockAnalyzeProject).toHaveBeenCalledWith(customPath);
      expect(result).toEqual(mockAnalysis);
    });

    it("calls analyzeProject with provided path override", async () => {
      const { Brainstorm } = await import("../index.js");
      const overridePath = "/override/path";
      const mockAnalysis = { files: ["a.ts"], imports: [] };
      mockAnalyzeProject.mockReturnValue(mockAnalysis);

      const bs = new Brainstorm({ projectPath: "/original" });
      const result = bs.analyze(overridePath);

      expect(mockAnalyzeProject).toHaveBeenCalledWith(overridePath);
      expect(result).toEqual(mockAnalysis);
    });
  });

  describe("generateDocs()", () => {
    it("calls generateAllDocs with analysis and outputDir", async () => {
      const { Brainstorm } = await import("../index.js");
      const mockAnalysis = { files: ["src/index.ts"] } as any;
      const mockResult = { files: ["docs/index.md"], count: 1 };
      mockGenerateAllDocs.mockReturnValue(mockResult);

      const bs = new Brainstorm();
      const result = bs.generateDocs(mockAnalysis, "/output/docs");

      expect(mockGenerateAllDocs).toHaveBeenCalledWith(
        mockAnalysis,
        "/output/docs",
      );
      expect(result).toEqual(mockResult);
    });

    it("calls generateAllDocs without outputDir when not provided", async () => {
      const { Brainstorm } = await import("../index.js");
      const mockAnalysis = { files: [] } as any;
      const mockResult = { files: [], count: 0 };
      mockGenerateAllDocs.mockReturnValue(mockResult);

      const bs = new Brainstorm();
      const result = bs.generateDocs(mockAnalysis);

      expect(mockGenerateAllDocs).toHaveBeenCalledWith(mockAnalysis, undefined);
      expect(result).toEqual(mockResult);
    });
  });

  describe("classify()", () => {
    it("returns classification result with all expected fields", async () => {
      const { Brainstorm } = await import("../index.js");

      const bs = new Brainstorm({ strategy: "quality-first" });
      const result = bs.classify("Fix the auth bug");

      expect(result).toHaveProperty("type");
      expect(result).toHaveProperty("complexity");
      expect(result).toHaveProperty("model");
      expect(result).toHaveProperty("strategy");
      expect(result).toHaveProperty("reason");
    });

    it("applies custom strategy when provided in options", async () => {
      const { Brainstorm } = await import("../index.js");

      const mockRouterInstance = {
        setStrategy: vi.fn(),
        classify: vi.fn().mockReturnValue({
          type: "refactor",
          complexity: "high",
        }),
        route: vi.fn().mockReturnValue({
          model: { name: "cheap-model" },
          strategy: "cost-first",
          reason: "Budget conscious",
        }),
      };
      mockBrainstormRouter.mockImplementation(() => mockRouterInstance);

      const bs = new Brainstorm({ strategy: "cost-first" });
      bs.classify("Simple refactor");

      expect(mockRouterInstance.setStrategy).toHaveBeenCalledWith("cost-first");
    });
  });

  describe("run()", () => {
    it("processes text-delta events and accumulates response", async () => {
      const { Brainstorm } = await import("../index.js");

      // Mock async generator that yields text-delta events
      async function* mockEventGenerator() {
        yield { type: "text-delta", delta: "Hello" };
        yield { type: "text-delta", delta: " " };
        yield { type: "text-delta", delta: "world" };
        yield {
          type: "routing",
          decision: { model: { name: "gpt-4-turbo" } },
        };
      }

      mockRunAgentLoop.mockReturnValue(mockEventGenerator());

      const bs = new Brainstorm();
      const result = await bs.run("Say hello");

      expect(result.text).toBe("Hello world");
      expect(result.modelUsed).toBe("gpt-4-turbo");
      expect(result.events).toHaveLength(4);
    });

    it("counts tool-call-start events correctly", async () => {
      const { Brainstorm } = await import("../index.js");

      async function* mockEventGenerator() {
        yield { type: "text-delta", delta: "Thinking" };
        yield { type: "tool-call-start", tool: "shell" };
        yield { type: "tool-call-start", tool: "file_read" };
        yield { type: "text-delta", delta: "Done" };
      }

      mockRunAgentLoop.mockReturnValue(mockEventGenerator());

      const bs = new Brainstorm();
      const result = await bs.run("Run some tools");

      expect(result.toolCalls).toBe(2);
    });

    it("returns cost from cost tracker", async () => {
      const { Brainstorm } = await import("../index.js");

      async function* mockEventGenerator() {
        yield { type: "text-delta", delta: "Response" };
      }

      mockRunAgentLoop.mockReturnValue(mockEventGenerator());
      mockCostTracker.mockImplementation(() => ({
        getSessionCost: vi.fn().mockReturnValue(0.123),
      }));

      const bs = new Brainstorm();
      const result = await bs.run("Test");

      expect(result.cost).toBe(0.123);
    });

    it("respects maxSteps option", async () => {
      const { Brainstorm } = await import("../index.js");

      async function* mockEventGenerator() {
        yield { type: "text-delta", delta: "Done" };
      }

      mockRunAgentLoop.mockReturnValue(mockEventGenerator());

      const bs = new Brainstorm({ maxSteps: 3 });
      await bs.run("Test prompt");

      expect(mockRunAgentLoop).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ maxSteps: 3 }),
      );
    });

    it("respects disableTools option", async () => {
      const { Brainstorm } = await import("../index.js");

      async function* mockEventGenerator() {
        yield { type: "text-delta", delta: "Done" };
      }

      mockRunAgentLoop.mockReturnValue(mockEventGenerator());

      const bs = new Brainstorm({ tools: false });
      await bs.run("Test prompt");

      expect(mockRunAgentLoop).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ disableTools: true }),
      );
    });

    it("applies preferredModel from options", async () => {
      const { Brainstorm } = await import("../index.js");

      async function* mockEventGenerator() {
        yield { type: "text-delta", delta: "Done" };
      }

      mockRunAgentLoop.mockReturnValue(mockEventGenerator());

      const bs = new Brainstorm({ model: "claude-3-haiku" });
      await bs.run("Test prompt");

      expect(mockRunAgentLoop).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ preferredModelId: "claude-3-haiku" }),
      );
    });
  });
});
