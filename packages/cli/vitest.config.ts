import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/__tests__/**/*.test.{ts,tsx}"],
    testTimeout: 10_000,
    // Force chalk/Ink to emit ANSI color codes even in non-TTY test env
    env: {
      FORCE_COLOR: "1",
    },
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
});
