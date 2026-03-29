/**
 * Auto-Lint Hook — runs the project linter after file writes.
 * Detects eslint, biome, or prettier in the project and runs --fix.
 * Non-blocking: reports lint results but doesn't prevent writes.
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { HookDefinition } from "../types.js";

export type LinterType =
  | "eslint"
  | "biome"
  | "prettier"
  | "golangci-lint"
  | "go-vet"
  | null;

/** Detect which linter is configured in the project. */
export function detectLinter(projectPath: string): LinterType {
  // Go projects: check for golangci-lint config first, fall back to go vet
  if (existsSync(join(projectPath, "go.mod"))) {
    const golangciConfigs = [
      ".golangci.yml",
      ".golangci.yaml",
      ".golangci.toml",
      ".golangci.json",
    ];
    if (golangciConfigs.some((c) => existsSync(join(projectPath, c)))) {
      return "golangci-lint";
    }
    // go vet is always available in a Go project
    return "go-vet";
  }

  // Check for biome first (newer, faster)
  if (
    existsSync(join(projectPath, "biome.json")) ||
    existsSync(join(projectPath, "biome.jsonc"))
  ) {
    return "biome";
  }

  // Check for eslint
  const eslintConfigs = [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.ts",
    ".eslintrc.js",
    ".eslintrc.json",
    ".eslintrc.yml",
    ".eslintrc",
  ];
  if (eslintConfigs.some((c) => existsSync(join(projectPath, c)))) {
    return "eslint";
  }

  // Check for prettier
  const prettierConfigs = [
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.yml",
    "prettier.config.js",
  ];
  if (prettierConfigs.some((c) => existsSync(join(projectPath, c)))) {
    return "prettier";
  }

  return null;
}

/** Run the detected linter on a file. Returns lint output or null if not available. */
export function runLint(
  filePath: string,
  projectPath: string,
): { output: string; fixed: boolean } | null {
  const linter = detectLinter(projectPath);
  if (!linter) return null;

  try {
    switch (linter) {
      case "biome": {
        const output = execFileSync(
          "npx",
          ["biome", "check", "--fix", filePath],
          {
            cwd: projectPath,
            encoding: "utf-8",
            timeout: 10000,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        return { output: output.trim(), fixed: true };
      }
      case "eslint": {
        const output = execFileSync("npx", ["eslint", "--fix", filePath], {
          cwd: projectPath,
          encoding: "utf-8",
          timeout: 15000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { output: output.trim(), fixed: true };
      }
      case "prettier": {
        const output = execFileSync("npx", ["prettier", "--write", filePath], {
          cwd: projectPath,
          encoding: "utf-8",
          timeout: 10000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { output: output.trim(), fixed: true };
      }
      case "golangci-lint": {
        const output = execFileSync(
          "golangci-lint",
          ["run", "--fix", filePath],
          {
            cwd: projectPath,
            encoding: "utf-8",
            timeout: 30000,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        return { output: output.trim(), fixed: true };
      }
      case "go-vet": {
        // go vet doesn't fix — it only reports. Run on the package containing the file.
        const output = execFileSync("go", ["vet", "./..."], {
          cwd: projectPath,
          encoding: "utf-8",
          timeout: 20000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { output: output.trim(), fixed: false };
      }
    }
  } catch (err: any) {
    // Linter found issues but couldn't auto-fix — return the error output
    const stderr = err.stderr ?? err.message ?? "";
    return { output: stderr.slice(0, 500), fixed: false };
  }

  return null;
}

/** Create auto-lint hook definitions for PostToolUse on file write tools. */
export function createAutoLintHooks(projectPath: string): HookDefinition[] {
  const linter = detectLinter(projectPath);
  if (!linter) return [];

  const lintCommands: Record<string, string> = {
    biome: "npx biome check --fix",
    eslint: "npx eslint --fix",
    prettier: "npx prettier --write",
    "golangci-lint": "golangci-lint run --fix",
    "go-vet": "go vet ./...",
  };
  const lintCommand = lintCommands[linter];

  return [
    {
      event: "PostToolUse",
      matcher: "file_write|file_edit|multi_edit|batch_edit",
      type: "command" as const,
      command: `${lintCommand} "$FILE"`,
      blocking: false,
      description: `Auto-lint with ${linter} after file writes`,
    },
  ];
}
