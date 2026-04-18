/**
 * Mode sweep live e2e.
 *
 * Clicks through every top-level mode and asserts the view root mounts
 * without throwing. Broadest-coverage test in the suite: any view that
 * crashes on mount (missing prop, undefined dereference, bad hook
 * contract) surfaces here before it reaches the user.
 *
 * Pairs with a pageerror accumulator — if any view emits a React
 * runtime error during the sweep, the test fails even if its root
 * happens to paint enough to satisfy the locator.
 */

import { test, expect, _electron as electron } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = join(__dirname, "..");
const WORKSPACE_BIN = join(DESKTOP_ROOT, "..", "..", "node_modules", ".bin");

// Mirrors AppMode in src/App.tsx. If new modes are added there, add the
// matching entry here — the sweep must cover every nav button.
const MODES: Array<{
  id: string;
  /** Locator inside the view that must be visible after click. */
  rootLocator: (
    window: import("@playwright/test").Page,
  ) =>
    | ReturnType<import("@playwright/test").Page["locator"]>
    | ReturnType<import("@playwright/test").Page["getByTestId"]>;
}> = [
  { id: "chat", rootLocator: (w) => w.getByTestId("chat-input") },
  { id: "plan", rootLocator: (w) => w.getByTestId("plan-view") },
  { id: "dashboard", rootLocator: (w) => w.getByTestId("dashboard-view") },
  { id: "models", rootLocator: (w) => w.getByTestId("models-view") },
  { id: "memory", rootLocator: (w) => w.locator(".mode-crossfade").first() },
  { id: "skills", rootLocator: (w) => w.locator(".mode-crossfade").first() },
  { id: "workflows", rootLocator: (w) => w.locator(".mode-crossfade").first() },
  { id: "security", rootLocator: (w) => w.getByTestId("run-red-team") },
  { id: "config", rootLocator: (w) => w.locator(".mode-crossfade").first() },
  // "trace" is clickable via palette but not in the sidebar's main list;
  // covered elsewhere.
];

test("mode sweep: every mode mounts its view without throwing", async () => {
  const patchedPath = `${WORKSPACE_BIN}:${process.env.PATH ?? ""}`;
  const app = await electron.launch({
    args: [DESKTOP_ROOT],
    env: { ...process.env, PATH: patchedPath },
  });

  const logs: string[] = [];
  const pageErrors: string[] = [];

  try {
    const isAppWindow = (url: string) =>
      url.startsWith("http://localhost:1420") ||
      url.includes("/dist/index.html");
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
    if (!window) throw new Error("Brainstorm window never appeared");

    window.on("pageerror", (e) => {
      pageErrors.push(e.message);
      logs.push(`PAGEERROR: ${e.message}`);
    });
    window.on("console", (m) => {
      if (m.type() === "error") logs.push(`RENDERER [error] ${m.text()}`);
    });

    await expect(window.getByTestId("boot-splash")).toBeHidden({
      timeout: 30_000,
    });
    await expect(window.getByTestId("app-root")).toBeVisible({
      timeout: 10_000,
    });

    for (const mode of MODES) {
      const button = window.getByTestId(`mode-${mode.id}`);
      await expect(button, `nav button for ${mode.id}`).toBeVisible({
        timeout: 5_000,
      });
      await button.click();

      try {
        await expect(mode.rootLocator(window)).toBeVisible({ timeout: 7_000 });
      } catch (err) {
        logs.push(`FAILED on mode=${mode.id}`);
        const html = await window
          .evaluate(() => document.documentElement.outerHTML)
          .catch(() => "<evaluate failed>");
        logs.push(`--- DOM at ${mode.id} failure ---\n${html.slice(0, 2000)}`);
        console.error(
          `Mode sweep failed at ${mode.id}. Captured logs:\n` + logs.join("\n"),
        );
        throw err;
      }
    }

    if (pageErrors.length > 0) {
      console.error(
        `Page errors collected during sweep:\n${pageErrors.join("\n")}`,
      );
      throw new Error(
        `Mode sweep completed but ${pageErrors.length} renderer error(s) fired. ` +
          `First: ${pageErrors[0]}`,
      );
    }
  } finally {
    await app.close();
  }
});
