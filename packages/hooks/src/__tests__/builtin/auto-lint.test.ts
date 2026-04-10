// @ts-nocheck — autonomously generated, type fixtures simplified
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import {
  detectLinter,
  createAutoLintHooks,
  type LinterType,
} from "../../builtin/auto-lint.js";

// Mock fs module
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

const mockedExistsSync = vi.mocked(existsSync);

describe("detectLinter", () => {
  const projectPath = "/test/project";

  beforeEach(() => {
    mockedExistsSync.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no linter config is found", () => {
    mockedExistsSync.mockReturnValue(false);

    const result = detectLinter(projectPath);

    expect(result).toBeNull();
  });

  it("detects biome from biome.json", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes("biome.json");
    });

    const result = detectLinter(projectPath);

    expect(result).toBe("biome");
  });

  it("detects biome from biome.jsonc", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes("biome.jsonc");
    });

    const result = detectLinter(projectPath);

    expect(result).toBe("biome");
  });

  it("detects eslint from eslint.config.js", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes("eslint.config.js");
    });

    const result = detectLinter(projectPath);

    expect(result).toBe("eslint");
  });

  it("detects eslint from .eslintrc.json", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes(".eslintrc.json");
    });

    const result = detectLinter(projectPath);

    expect(result).toBe("eslint");
  });

  it("detects prettier from .prettierrc", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes(".prettierrc");
    });

    const result = detectLinter(projectPath);

    expect(result).toBe("prettier");
  });

  it("detects golangci-lint when go.mod and config exist", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      if (path.includes("go.mod")) return true;
      if (path.includes(".golangci.yml")) return true;
      return false;
    });

    const result = detectLinter(projectPath);

    expect(result).toBe("golangci-lint");
  });

  it("falls back to go-vet for Go projects without golangci-lint config", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes("go.mod");
    });

    const result = detectLinter(projectPath);

    expect(result).toBe("go-vet");
  });

  it("prefers biome over eslint when both configs exist", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes("biome.json") || path.includes("eslint.config.js");
    });

    const result = detectLinter(projectPath);

    // Biome is checked first, so it should be detected
    expect(result).toBe("biome");
  });

  it("detects golangci-lint with various config formats", () => {
    const configs = [
      ".golangci.yml",
      ".golangci.yaml",
      ".golangci.toml",
      ".golangci.json",
    ];

    for (const config of configs) {
      mockedExistsSync.mockReset();
      mockedExistsSync.mockImplementation((path: string) => {
        if (path.includes("go.mod")) return true;
        return path.includes(config);
      });

      const result = detectLinter(projectPath);
      expect(result).toBe("golangci-lint");
    }
  });
});

describe("createAutoLintHooks", () => {
  const projectPath = "/test/project";

  beforeEach(() => {
    mockedExistsSync.mockReset();
  });

  it("returns empty array when no linter is detected", () => {
    mockedExistsSync.mockReturnValue(false);

    const hooks = createAutoLintHooks(projectPath);

    expect(hooks).toEqual([]);
  });

  it("creates biome hook with correct command", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes("biome.json");
    });

    const hooks = createAutoLintHooks(projectPath);

    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({
      event: "PostToolUse",
      matcher: "file_write|file_edit|multi_edit|batch_edit",
      type: "command",
      command: 'npx biome check --fix "$FILE"',
      blocking: false,
      description: "Auto-lint with biome after file writes",
    });
  });

  it("creates eslint hook with correct command", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes("eslint.config.js");
    });

    const hooks = createAutoLintHooks(projectPath);

    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({
      event: "PostToolUse",
      type: "command",
      command: 'npx eslint --fix "$FILE"',
    });
  });

  it("creates prettier hook with correct command", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes(".prettierrc");
    });

    const hooks = createAutoLintHooks(projectPath);

    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({
      event: "PostToolUse",
      type: "command",
      command: 'npx prettier --write "$FILE"',
    });
  });

  it("creates go-vet hook with correct command", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes("go.mod");
    });

    const hooks = createAutoLintHooks(projectPath);

    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({
      event: "PostToolUse",
      type: "command",
      command: 'go vet ./... "$FILE"',
    });
  });
});
