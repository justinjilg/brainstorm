import { defineConfig } from "@playwright/test";

/**
 * Live e2e config — Playwright launches the built Electron binary and
 * talks to a real `brainstorm ipc` child process. The point of this
 * suite is the opposite of tests/app.spec.ts: NO setupAllMocks, NO HTTP
 * fallback, every assertion must go through the real preload bridge.
 *
 * Run with: npx playwright test --config tests-live/playwright.live.config.ts
 *
 * Preconditions:
 *  - @brainst0rm/cli is on PATH (workspace bin wired via npm link or the
 *    launcher script below prepends it).
 *  - electron/dist/main.js and electron/dist/preload.cjs are built
 *    (`npm run build:electron`).
 *  - Vite isn't already running on :1420.
 */
export default defineConfig({
  testDir: ".",
  testMatch: /\.live\.spec\.ts$/,
  // Live tests are inherently serial — they all share one Electron app
  // instance per file and one port.
  workers: 1,
  fullyParallel: false,
  // Cold boot + backend spawn + DB migrations are slow the first time.
  timeout: 60_000,
  retries: 0,
  reporter: "list",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // Electron's main.ts switches on app.isPackaged — `electron .` is
  // always unpackaged, so it loads http://localhost:1420. Bring Vite up
  // before the tests run so loadURL doesn't fail with
  // ERR_CONNECTION_REFUSED. We leave a running Vite untouched if one's
  // already on :1420 (reuseExistingServer=true) so the dev loop stays
  // fast.
  webServer: {
    command: "npx vite --port 1420",
    port: 1420,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
