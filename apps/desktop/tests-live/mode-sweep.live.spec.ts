/**
 * Place sweep live e2e.
 *
 * Clicks through every canvas place (Talk / Council / Growth), opens the Pulse
 * feed and the Settings drawer, and asserts each root mounts without throwing.
 * Broadest-coverage test in the suite: any place that crashes on mount (missing
 * prop, undefined dereference, bad hook contract) surfaces here before it
 * reaches the user.
 *
 * Pairs with a pageerror accumulator — if any place emits a React runtime error
 * during the sweep, the test fails even if its root happens to paint enough to
 * satisfy the locator.
 */

import { test, expect, _electron as electron } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = join(__dirname, "..");
const WORKSPACE_BIN = join(DESKTOP_ROOT, "..", "..", "node_modules", ".bin");

// Canvas places in the new shell (the 5×5 mode grid was deleted). If a place is
// added to places/registry.ts, add its rail testid + a root marker here.
const PLACES: Array<{
  id: string;
  navTestId: string;
  rootLocator: (
    window: import("@playwright/test").Page,
  ) =>
    | ReturnType<import("@playwright/test").Page["locator"]>
    | ReturnType<import("@playwright/test").Page["getByTestId"]>;
}> = [
  {
    id: "talk",
    navTestId: "place-talk",
    rootLocator: (w) => w.getByTestId("chat-input"),
  },
  {
    id: "council",
    navTestId: "place-council",
    rootLocator: (w) => w.getByText("Council", { exact: false }).first(),
  },
  {
    id: "growth",
    navTestId: "place-growth",
    rootLocator: (w) => w.getByTestId("tier-all"),
  },
];

test("place sweep: every place mounts its view without throwing", async () => {
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
    await expect(window.getByTestId("app-shell")).toBeVisible({
      timeout: 10_000,
    });

    const failDump = async (label: string, err: unknown) => {
      logs.push(`FAILED on ${label}`);
      const html = await window!
        .evaluate(() => document.documentElement.outerHTML)
        .catch(() => "<evaluate failed>");
      logs.push(`--- DOM at ${label} failure ---\n${html.slice(0, 2000)}`);
      console.error(
        `Sweep failed at ${label}. Captured logs:\n` + logs.join("\n"),
      );
      throw err;
    };

    for (const place of PLACES) {
      const button = window.getByTestId(place.navTestId);
      await expect(button, `rail button for ${place.id}`).toBeVisible({
        timeout: 5_000,
      });
      await button.click();
      try {
        await expect(place.rootLocator(window)).toBeVisible({ timeout: 7_000 });
      } catch (err) {
        await failDump(`place=${place.id}`, err);
      }
    }

    // The openable Pulse feed.
    try {
      await window.getByTestId("rail-heart").click();
      await expect(window.getByTestId("pulse-ledger")).toBeVisible({
        timeout: 7_000,
      });
      await window.keyboard.press("Escape");
    } catch (err) {
      await failDump("pulse", err);
    }

    // The Settings drawer.
    try {
      await window.getByTestId("rail-settings").click();
      await expect(window.getByTestId("settings-drawer")).toBeVisible({
        timeout: 7_000,
      });
      await window.keyboard.press("Escape");
    } catch (err) {
      await failDump("settings", err);
    }

    if (pageErrors.length > 0) {
      console.error(
        `Page errors collected during sweep:\n${pageErrors.join("\n")}`,
      );
      throw new Error(
        `Place sweep completed but ${pageErrors.length} renderer error(s) fired. ` +
          `First: ${pageErrors[0]}`,
      );
    }
  } finally {
    await app.close();
  }
});
