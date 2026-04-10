/**
 * Build Verification Tool — auto-detect and run build/lint commands.
 *
 * After code is written, this tool verifies it compiles/parses.
 * Auto-detects the build system from the project (go, tsc, cargo, python).
 * When autofix is true, returns errors to the LLM for correction (max 3 attempts).
 *
 * Learned from: Living Case Study — agents wrote code that didn't compile
 * and nobody caught it because there was no build verification step.
 */

import { z } from "zod";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { defineTool } from "../base.js";
import { getWorkspace } from "../workspace-context.js";

function detectBuildCommand(cwd: string): string | null {
  if (existsSync(join(cwd, "go.mod"))) return "go vet ./...";
  if (existsSync(join(cwd, "tsconfig.json"))) return "npx tsc --noEmit";
  if (existsSync(join(cwd, "Cargo.toml"))) return "cargo check";
  if (existsSync(join(cwd, "pyproject.toml")))
    return "python -m compileall -q .";
  if (existsSync(join(cwd, "package.json"))) {
    try {
      const pkg = JSON.parse(
        require("node:fs").readFileSync(join(cwd, "package.json"), "utf-8"),
      );
      if (pkg.scripts?.build) return "npm run build";
      if (pkg.scripts?.typecheck) return "npm run typecheck";
    } catch {
      /* ignore */
    }
  }
  return null;
}

function runCommand(
  command: string,
  cwd: string,
): { passed: boolean; output: string; command: string } {
  try {
    // Use shell execution to handle quoting, pipes, and composite commands correctly
    const stdout = execFileSync("/bin/sh", ["-c", command], {
      cwd,
      stdio: "pipe",
      timeout: 120_000,
      encoding: "utf-8",
    });
    return { passed: true, output: stdout.slice(0, 2000), command };
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const stdout = (err as { stdout?: string }).stdout ?? "";
    return {
      passed: false,
      output: (stderr + "\n" + stdout).trim().slice(0, 3000),
      command,
    };
  }
}

export const buildVerifyTool = defineTool({
  name: "build_verify",
  description:
    "Run build/lint verification on the project. Auto-detects build system (Go, TypeScript, Rust, Python) or accepts a custom command. Returns pass/fail with error output. Use after writing code to verify it compiles.",
  permission: "confirm",
  inputSchema: z.object({
    command: z
      .string()
      .optional()
      .describe(
        "Build command to run. If omitted, auto-detects from project (go vet, tsc --noEmit, cargo check, etc.)",
      ),
    cwd: z
      .string()
      .optional()
      .describe("Working directory. Defaults to current directory."),
  }),
  async execute({ command, cwd }) {
    const workDir = resolve(cwd ?? getWorkspace());

    const buildCmd = command ?? detectBuildCommand(workDir);
    if (!buildCmd) {
      return {
        passed: false,
        command: "none",
        output: "No build system detected. Provide a command explicitly.",
        attempt: 1,
      };
    }

    const result = runCommand(buildCmd, workDir);

    return {
      passed: result.passed,
      command: result.command,
      output: result.output,
      ...(result.passed
        ? {}
        : {
            fix_instruction:
              "The build failed. Read the error output above and fix the code. Then run build_verify again to confirm the fix.",
          }),
    };
  },
});
