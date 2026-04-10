import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/**/*.test.ts"],
    },
  },
});
