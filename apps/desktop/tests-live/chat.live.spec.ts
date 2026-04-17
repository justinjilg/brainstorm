/**
 * Chat happy-path live e2e.
 *
 * This is the test that would've caught every single one of the hour-of-
 * breakage bugs we just shipped through: preload.cjs missing, CSP block,
 * event-shape mismatch between IPC and useChat, env-only key resolution.
 * All of those were invisible to the mocked Playwright suite because it
 * exercises the HTTP fallback path; this one drives the real bridge.
 *
 * Precondition: 1Password service-account token OR a direct provider key
 * is exported in the environment the test runs from. Without that the
 * router has no models to pick and chat fails by design.
 */

import { test, expect, _electron as electron } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = join(__dirname, "..");
const WORKSPACE_BIN = join(DESKTOP_ROOT, "..", "..", "node_modules", ".bin");

test("send 'hello' and receive a streamed assistant response", async () => {
  const patchedPath = `${WORKSPACE_BIN}:${process.env.PATH ?? ""}`;

  const app = await electron.launch({
    args: [DESKTOP_ROOT],
    env: { ...process.env, PATH: patchedPath },
  });

  const mainLog: string[] = [];
  app.on("console", (m) => mainLog.push(`MAIN: ${m.text()}`));

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

    window.on("pageerror", (e) => mainLog.push(`PAGEERROR: ${e.message}`));
    window.on("console", (m) =>
      mainLog.push(`RENDERER [${m.type()}] ${m.text()}`),
    );

    try {
      await expect(window.getByTestId("boot-splash")).toBeHidden({
        timeout: 30_000,
      });
      await expect(window.getByTestId("app-root")).toBeVisible({
        timeout: 10_000,
      });
    } catch (err) {
      const html = await window
        .evaluate(() => document.documentElement.outerHTML)
        .catch(() => "<unable to evaluate>");
      mainLog.push(`--- DOM at boot failure ---\n${html.slice(0, 2000)}`);
      console.error(
        "BOOT PHASE FAILED in chat test. Captured logs:\n" + mainLog.join("\n"),
      );
      throw err;
    }

    // Chat is the default mode. The textarea has no explicit test id;
    // pick it by role — placeholder + type are stable enough.
    const input = window
      .getByRole("textbox")
      .or(window.locator('textarea, input[type="text"]'))
      .first();
    await expect(input).toBeVisible({ timeout: 10_000 });

    try {
      await input.click();
      await input.fill("hello");
      await input.press("Enter");

      // User message must land first — if this doesn't appear the input
      // isn't wired at all, bail before blaming the backend.
      await expect(window.getByTestId("message-user").first()).toBeVisible({
        timeout: 5_000,
      });

      // Assistant message mounts after the backend streams text-delta
      // events into useChat. Before the bug fix, no assistant message
      // appeared because the event shape was wrong. This assertion is
      // the regression guard for that entire class of bug.
      const assistantMsg = window.getByTestId("message-assistant").first();
      await expect(assistantMsg).toBeVisible({ timeout: 45_000 });

      // Verify it actually contains non-empty text, not just a shell.
      const text = (await assistantMsg.innerText()) ?? "";
      expect(text.trim().length).toBeGreaterThan(1);
    } catch (err) {
      console.error(
        "CHAT LIVE TEST FAILED. Captured logs:\n" + mainLog.join("\n"),
      );
      throw err;
    }
  } finally {
    await app.close();
  }
});
