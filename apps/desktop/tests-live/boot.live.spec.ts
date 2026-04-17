/**
 * Boot + first-render live e2e.
 *
 * This is the smallest honest test of the desktop app: launch the
 * packaged Electron binary against a real brainstorm ipc backend, wait
 * for the BootSplash to dismiss, and assert the main shell mounted.
 * If this fails, nothing else about the app matters.
 *
 * It deliberately bypasses Vite + HMR — it spawns Electron directly
 * against the pre-built dist/index.html so we catch packaging bugs
 * (preload path, CSP for file://, ESM interop at startup). The dev
 * loop inside Vite is covered by the existing tests/app.spec.ts.
 */

import { test, expect, _electron as electron } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = join(__dirname, "..");
const WORKSPACE_BIN = join(DESKTOP_ROOT, "..", "..", "node_modules", ".bin");

test("cold boot: Electron window paints the main shell", async () => {
  // Put the workspace brainstorm CLI ahead of anything the user has on
  // PATH (e.g. a Python homonym) so the ipc child is actually our Node
  // CLI from packages/cli/dist.
  const patchedPath = `${WORKSPACE_BIN}:${process.env.PATH ?? ""}`;

  const app = await electron.launch({
    args: [DESKTOP_ROOT],
    env: { ...process.env, PATH: patchedPath, NODE_ENV: "production" },
    // electron-builder's packaged entry is electron/dist/main.js — but
    // we're running the app in the Electron runtime from node_modules,
    // so `app: DESKTOP_ROOT` is the cwd and main is taken from
    // package.json -> "main".
  });

  // Capture everything useful from the Electron main process so test
  // failures land with actionable evidence instead of "element not
  // found". Each hook writes into a shared log that we print on failure.
  const mainLog: string[] = [];
  app.on("console", (m) => mainLog.push(`MAIN: ${m.text()}`));

  try {
    // The app opens a detached DevTools window in dev mode, and
    // app.firstWindow() often returns THAT instead of the Brainstorm
    // window (race between which is ready first). Explicitly pick the
    // one loaded from localhost:1420 or our dist/index.html.
    const isAppWindow = (url: string) =>
      url.startsWith("http://localhost:1420") ||
      url.includes("/dist/index.html");

    // Wait up to 15s for the app window to appear. Don't short-circuit
    // on the first window — DevTools can arrive first and pollute
    // firstWindow().
    const deadline = Date.now() + 15_000;
    let window: import("@playwright/test").Page | null = null;
    while (Date.now() < deadline) {
      const match = app.windows().find((w) => isAppWindow(w.url()));
      if (match) {
        window = match;
        break;
      }
      await app.waitForEvent("window", { timeout: 2_000 }).catch(() => null);
    }
    if (!window) {
      throw new Error(
        `Brainstorm window never appeared. Current windows: ${app
          .windows()
          .map((w) => w.url())
          .join(", ")}`,
      );
    }

    window.on("pageerror", (e) => mainLog.push(`PAGEERROR: ${e.message}`));
    window.on("console", (m) =>
      mainLog.push(`RENDERER [${m.type()}] ${m.text()}`),
    );
    window.on("requestfailed", (r) =>
      mainLog.push(`REQFAIL ${r.url()} — ${r.failure()?.errorText}`),
    );

    await window.waitForLoadState("domcontentloaded");

    // Capture the body HTML if the assertion is about to fail — better
    // than a screenshot for tracing what React rendered (or didn't).
    const dumpDomOnFail = async () => {
      const html = await window
        .evaluate(() => document.documentElement.outerHTML)
        .catch(() => "<unable to evaluate>");
      mainLog.push(`--- DOM dump ---\n${html.slice(0, 4000)}`);
    };

    try {
      // The boot splash must either dismiss OR never appear (backend
      // can be ready before splash paints in some fast-boot cases).
      const splash = window.getByTestId("boot-splash");
      await expect(splash).toBeHidden({ timeout: 30_000 });

      // Main shell mounted.
      await expect(window.getByTestId("app-root")).toBeVisible({
        timeout: 10_000,
      });
    } catch (err) {
      await dumpDomOnFail();
      console.error("LIVE TEST FAILED. Captured logs:\n" + mainLog.join("\n"));
      throw err;
    }
  } finally {
    await app.close();
  }
});
