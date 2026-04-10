import { defineConfig } from "vitest/config";

// Suppress pino stderr during tests — prevents false-positive exit code 1
// from unhandled async log writes after vitest completes.
// Must be set in env so it propagates to vitest worker processes.
process.env.BRAINSTORM_LOG_LEVEL = "silent";

export default defineConfig({
  test: {
    env: {
      BRAINSTORM_LOG_LEVEL: "silent",
    },
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/**/*.test.ts"],
    },
  },
});
