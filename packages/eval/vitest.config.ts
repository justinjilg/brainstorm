import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000, // scorer tests invoke tsc, which is slow on CI
  },
});
