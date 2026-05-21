import { defineConfig } from "vitest/config";

/**
 * Vitest config for the protocol-tier tests under tests-protocol/.
 *
 * These are unit tests that exercise the wire-format primitives in
 * src/lib/ipc-protocol.ts without launching Electron or Vite. Fast,
 * adversarial, and deterministic — the first layer of the three-tier
 * reliability harness (protocol → contract → flow).
 *
 * Playwright tests under tests/ and tests-live/ are deliberately
 * excluded from Vitest's include glob; they run under `npx playwright
 * test` in their own process.
 */
export default defineConfig({
  test: {
    // Picks up:
    //  - tests-protocol/**/*.test.ts (the original wire-format unit suite)
    //  - src/**/*.test.ts and src/**/*.test.tsx (in-tree unit tests beside
    //    the code they exercise, added in opus PR 6 onward)
    include: [
      "tests-protocol/**/*.test.ts",
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
    ],
    environment: "node",
    globals: false,
  },
});
