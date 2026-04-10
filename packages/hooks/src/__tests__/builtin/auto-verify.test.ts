// @ts-nocheck — autonomously generated, type fixtures simplified
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import {
  detectTestRunner,
  detectBuildCommand,
  createAutoVerifyHooks,
} from "../../builtin/auto-verify.js";

// Mock fs module
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

const mockedExistsSync = vi.mocked(existsSync);

describe("detectTestRunner", () => {
  const projectPath = "/test/project";

  beforeEach(() => {
    mockedExistsSync.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no test runner config is found", () => {
    mockedExistsSync.mockReturnValue(false);

    const result = detectTestRunner(projectPath);

    expect(result).toBeNull();
  });

  it("detects vitest from vitest.config.ts", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes("vitest.config.ts");
    });

    const result = detectTestRunner(projectPath);

    expect(result).toBe("vitest");
  });

  it("detects vitest from vitest.config.js", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes("vitest.config.js");
    });

    const result = detectTestRunner(projectPath);

    expect(result).toBe("vitest");
  });

  it("detects jest from jest.config.js", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes("jest.config.js");
    });

    const result = detectTestRunner(projectPath);

    expect(result).toBe("jest");
  });

  it("detects pytest from pytest.ini", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes("pytest.ini");
    });

    const result = detectTestRunner(projectPath);

    expect(result).toBe("pytest");
  });

  it("detects pytest from pyproject.toml", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes("pyproject.toml");
    });

    const result = detectTestRunner(projectPath);

    expect(result).toBe("pytest");
  });

  it("detects go-test from go.mod", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes("go.mod");
    });

    const result = detectTestRunner(projectPath);

    expect(result).toBe("go-test");
  });

  it("detects cargo-test from Cargo.toml", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes("Cargo.toml");
    });

    const result = detectTestRunner(projectPath);

    expect(result).toBe("cargo-test");
  });

  it("prefers vitest over jest when both configs exist", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return (
        path.includes("vitest.config.ts") || path.includes("jest.config.js")
      );
    });

    const result = detectTestRunner(projectPath);

    // Vitest is checked first
    expect(result).toBe("vitest");
  });
});

describe("detectBuildCommand", () => {
  const projectPath = "/test/project";

  beforeEach(() => {
    mockedExistsSync.mockReset();
  });

  it("returns null when no build system is detected", () => {
    mockedExistsSync.mockReturnValue(false);

    const result = detectBuildCommand(projectPath);

    expect(result).toBeNull();
  });

  it("detects turborepo and returns npx turbo run build", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes("turbo.json");
    });

    const result = detectBuildCommand(projectPath);

    expect(result).toBe("npx turbo run build");
  });

  it("detects Makefile and returns make build", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes("Makefile");
    });

    const result = detectBuildCommand(projectPath);

    expect(result).toBe("make build");
  });

  it("detects Cargo.toml and returns cargo build", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes("Cargo.toml");
    });

    const result = detectBuildCommand(projectPath);

    expect(result).toBe("cargo build");
  });

  it("detects go.mod and returns go build ./...", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes("go.mod");
    });

    const result = detectBuildCommand(projectPath);

    expect(result).toBe("go build ./...");
  });

  it("prefers turborepo over package.json build script", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes("turbo.json") || path.includes("package.json");
    });

    const result = detectBuildCommand(projectPath);

    // Turborepo is checked first
    expect(result).toBe("npx turbo run build");
  });
});

describe("createAutoVerifyHooks", () => {
  const projectPath = "/test/project";

  beforeEach(() => {
    mockedExistsSync.mockReset();
  });

  it("returns empty array when no build or test tools are detected", () => {
    mockedExistsSync.mockReturnValue(false);

    const hooks = createAutoVerifyHooks(projectPath);

    expect(hooks).toEqual([]);
  });

  it("creates build hook when build system is detected", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes("turbo.json");
    });

    const hooks = createAutoVerifyHooks(projectPath);

    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({
      event: "Stop",
      type: "command",
      command: expect.stringContaining("npx turbo run build"),
      blocking: false,
      description: expect.stringContaining("Auto-build"),
    });
  });

  it("creates test hook when test runner is detected", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes("vitest.config.ts");
    });

    const hooks = createAutoVerifyHooks(projectPath);

    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({
      event: "Stop",
      type: "command",
      command: expect.stringContaining("npx vitest run"),
      blocking: false,
      description: expect.stringContaining("Auto-test"),
    });
  });

  it("creates both build and test hooks when both are detected", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes("turbo.json") || path.includes("vitest.config.ts");
    });

    const hooks = createAutoVerifyHooks(projectPath);

    expect(hooks).toHaveLength(2);
    expect(hooks.some((h) => h.description?.includes("build"))).toBe(true);
    expect(hooks.some((h) => h.description?.includes("test"))).toBe(true);
  });

  it("creates jest test hook with correct command", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes("jest.config.js");
    });

    const hooks = createAutoVerifyHooks(projectPath);

    expect(hooks).toHaveLength(1);
    expect(hooks[0].command).toContain("npx jest");
    expect(hooks[0].command).toContain("--passWithNoTests");
  });

  it("creates go-test hook with correct command", () => {
    mockedExistsSync.mockImplementation((path: string) => {
      return path.includes("go.mod");
    });

    const hooks = createAutoVerifyHooks(projectPath);

    expect(hooks).toHaveLength(2); // Both build and test
    const testHook = hooks.find((h) => h.description?.includes("test"));
    expect(testHook).toBeDefined();
    expect(testHook!.command).toContain("go test ./...");
  });
});
