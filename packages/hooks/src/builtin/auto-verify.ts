/**
 * Auto-Verify Hook Preset — runs lint + test + build after file writes.
 *
 * Inspired by Aider's auto-commit-with-lint-test loop.
 * Every verify result is a binary outcome signal that feeds Thompson sampling:
 * - build passed? → model that wrote the code gets a "success" signal
 * - tests failed? → model gets a "failure" signal
 *
 * This is the primary flywheel accelerator: every edit produces an outcome.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HookDefinition } from "../types.js";
import { detectLinter } from "./auto-lint.js";

const execFileAsync = promisify(execFile);

/** Detect the test runner configured in the project. */
export function detectTestRunner(
  projectPath: string,
): "vitest" | "jest" | "pytest" | "go-test" | "cargo-test" | null {
  // Node.js test runners
  if (
    existsSync(join(projectPath, "vitest.config.ts")) ||
    existsSync(join(projectPath, "vitest.config.js"))
  ) {
    return "vitest";
  }
  if (
    existsSync(join(projectPath, "jest.config.js")) ||
    existsSync(join(projectPath, "jest.config.ts"))
  ) {
    return "jest";
  }

  // Python
  if (
    existsSync(join(projectPath, "pytest.ini")) ||
    existsSync(join(projectPath, "pyproject.toml")) ||
    existsSync(join(projectPath, "setup.py"))
  ) {
    return "pytest";
  }

  // Go
  if (existsSync(join(projectPath, "go.mod"))) {
    return "go-test";
  }

  // Rust
  if (existsSync(join(projectPath, "Cargo.toml"))) {
    return "cargo-test";
  }

  return null;
}

/** Detect the build command for the project. */
export function detectBuildCommand(projectPath: string): string | null {
  // Turborepo
  if (existsSync(join(projectPath, "turbo.json"))) {
    return "npx turbo run build";
  }

  // package.json with build script
  if (existsSync(join(projectPath, "package.json"))) {
    try {
      const pkg = JSON.parse(
        require("node:fs").readFileSync(
          join(projectPath, "package.json"),
          "utf-8",
        ),
      );
      if (pkg.scripts?.build) return "npm run build";
    } catch {
      /* ignore */
    }
  }

  // Makefile
  if (existsSync(join(projectPath, "Makefile"))) {
    return "make build";
  }

  // Cargo
  if (existsSync(join(projectPath, "Cargo.toml"))) {
    return "cargo build";
  }

  // Go
  if (existsSync(join(projectPath, "go.mod"))) {
    return "go build ./...";
  }

  return null;
}

/** Run verification (lint + test + build) and return structured results. */
export async function runVerify(projectPath: string): Promise<VerifyResult> {
  const result: VerifyResult = {
    lint: null,
    test: null,
    build: null,
    allPassed: true,
  };

  // 1. Lint
  const linter = detectLinter(projectPath);
  if (linter) {
    try {
      const lintCmds: Record<string, [string, string[]]> = {
        biome: ["npx", ["biome", "check", "."]],
        eslint: ["npx", ["eslint", "."]],
        prettier: ["npx", ["prettier", "--check", "."]],
        "golangci-lint": ["golangci-lint", ["run", "./..."]],
        "go-vet": ["go", ["vet", "./..."]],
      };
      const cmd = lintCmds[linter] ?? ["npx", ["prettier", "--check", "."]];
      await execFileAsync(cmd[0] as string, cmd[1] as string[], {
        cwd: projectPath,
        timeout: 30000,
      });
      result.lint = { passed: true, tool: linter };
    } catch (err: any) {
      result.lint = {
        passed: false,
        tool: linter,
        output: (err.stderr ?? err.message ?? "").slice(0, 500),
      };
      result.allPassed = false;
    }
  }

  // 2. Test
  const testRunner = detectTestRunner(projectPath);
  if (testRunner) {
    try {
      const cmds: Record<string, [string, string[]]> = {
        vitest: ["npx", ["vitest", "run", "--passWithNoTests"]],
        jest: ["npx", ["jest", "--passWithNoTests"]],
        pytest: ["python3", ["-m", "pytest", "-x", "--tb=short"]],
        "go-test": ["go", ["test", "./..."]],
        "cargo-test": ["cargo", ["test"]],
      };
      const [bin, args] = cmds[testRunner];
      await execFileAsync(bin, args, { cwd: projectPath, timeout: 120000 });
      result.test = { passed: true, runner: testRunner };
    } catch (err: any) {
      result.test = {
        passed: false,
        runner: testRunner,
        output: (err.stderr ?? err.stdout ?? err.message ?? "").slice(0, 1000),
      };
      result.allPassed = false;
    }
  }

  // 3. Build
  const buildCmd = detectBuildCommand(projectPath);
  if (buildCmd) {
    try {
      const parts = buildCmd.split(/\s+/);
      await execFileAsync(parts[0], parts.slice(1), {
        cwd: projectPath,
        timeout: 120000,
      });
      result.build = { passed: true, command: buildCmd };
    } catch (err: any) {
      result.build = {
        passed: false,
        command: buildCmd,
        output: (err.stderr ?? err.stdout ?? err.message ?? "").slice(0, 1000),
      };
      result.allPassed = false;
    }
  }

  return result;
}

export interface VerifyResult {
  lint: { passed: boolean; tool: string; output?: string } | null;
  test: { passed: boolean; runner: string; output?: string } | null;
  build: { passed: boolean; command: string; output?: string } | null;
  allPassed: boolean;
}

/**
 * Create auto-verify hook definitions.
 * Fires on Stop event (after agent finishes responding) to verify the changes.
 */
export function createAutoVerifyHooks(projectPath: string): HookDefinition[] {
  const hooks: HookDefinition[] = [];

  const buildCmd = detectBuildCommand(projectPath);
  if (buildCmd) {
    hooks.push({
      event: "Stop",
      type: "command" as const,
      command: `cd "${projectPath}" && ${buildCmd}`,
      blocking: false,
      description: `Auto-build after agent response`,
    });
  }

  const testRunner = detectTestRunner(projectPath);
  if (testRunner) {
    const testCmds: Record<string, string> = {
      vitest: "npx vitest run --passWithNoTests",
      jest: "npx jest --passWithNoTests",
      pytest: "python3 -m pytest -x --tb=short",
      "go-test": "go test ./...",
      "cargo-test": "cargo test",
    };
    hooks.push({
      event: "Stop",
      type: "command" as const,
      command: `cd "${projectPath}" && ${testCmds[testRunner]}`,
      blocking: false,
      description: `Auto-test with ${testRunner} after agent response`,
    });
  }

  return hooks;
}
