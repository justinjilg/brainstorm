import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("eval:ts-verify");

/**
 * Check if a TypeScript file compiles without errors.
 * Uses tsc --noEmit with a minimal config.
 */
export function verifyTypeScriptCompiles(filePath: string): {
  ok: boolean;
  error?: string;
} {
  if (!existsSync(filePath)) {
    return { ok: false, error: `File not found: ${filePath}` };
  }

  try {
    execFileSync(
      "npx",
      [
        "tsc",
        "--noEmit",
        "--strict",
        "--target",
        "ES2022",
        "--module",
        "ESNext",
        "--moduleResolution",
        "bundler",
        filePath,
      ],
      {
        // 45s. The prior 15s timeout flaked intermittently on CI
        // Ubuntu runners where `npx tsc` cold-start (resolution +
        // tsc process boot) ate 10-14s before real compilation
        // even began. The scorer test "returns a perfect score"
        // hit exactly 15051ms several times — always the timeout,
        // never a genuine compile failure. Raise the ceiling to
        // comfortably cover npx+tsc startup on slow runners.
        timeout: 45000,
        stdio: "pipe",
      },
    );
    return { ok: true };
  } catch (error: any) {
    const stderr = error.stderr?.toString() ?? "";
    const stdout = error.stdout?.toString() ?? "";
    const msg = stderr || stdout || error.message;
    log.debug({ filePath, error: msg }, "TypeScript compilation failed");
    return { ok: false, error: msg.slice(0, 500) };
  }
}
