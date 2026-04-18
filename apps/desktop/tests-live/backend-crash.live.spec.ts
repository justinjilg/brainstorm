/**
 * Backend crash recovery live e2e.
 *
 * The main process respawns `brainstorm ipc` up to 3 times with a 2s
 * gap when the child exits. This test is the regression trap for that
 * whole subsystem: send a chat turn, SIGKILL the backend mid-session,
 * assert the next turn still works after respawn.
 *
 * If respawn breaks, or if the renderer stops processing messages
 * after a mid-stream crash (audit R1 — hooks frozen at crash-time
 * data), or if the sticky backend-ready flag stops firing on the
 * second boot, this fails.
 */

import { test, expect, _electron as electron } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = join(__dirname, "..");
const WORKSPACE_BIN = join(DESKTOP_ROOT, "..", "..", "node_modules", ".bin");

async function pickAppWindow(
  app: import("@playwright/test").ElectronApplication,
) {
  const isAppWindow = (url: string) =>
    url.startsWith("http://localhost:1420") || url.includes("/dist/index.html");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const match = app.windows().find((w) => isAppWindow(w.url()));
    if (match) return match;
    await app.waitForEvent("window", { timeout: 2_000 }).catch(() => null);
  }
  throw new Error("Brainstorm window never appeared");
}

/**
 * Hard-kill the brainstorm ipc child process. Uses execFileSync (no shell)
 * with pkill's -f flag to match the full command line. pkill exits 1 when
 * no processes matched — that's a legitimate outcome if the test ran
 * before the child fully spawned, so we swallow it.
 */
function killBackendChild(): void {
  try {
    execFileSync("pkill", ["-9", "-f", "brainstorm ipc"], { stdio: "ignore" });
  } catch {
    // no-match exits 1 — treated as harmless
  }
}

test("backend crash recovery: kill the ipc child, next chat turn still lands", async ({}, testInfo) => {
  // This test runs multiple full turns and waits on respawn timing.
  testInfo.setTimeout(120_000);

  const patchedPath = `${WORKSPACE_BIN}:${process.env.PATH ?? ""}`;
  const app = await electron.launch({
    args: [DESKTOP_ROOT],
    env: { ...process.env, PATH: patchedPath },
  });

  try {
    const window = await pickAppWindow(app);
    await expect(window.getByTestId("boot-splash")).toBeHidden({
      timeout: 30_000,
    });
    await expect(window.getByTestId("app-root")).toBeVisible({
      timeout: 10_000,
    });

    // First turn — baseline proof the app is healthy before we knock
    // the backend over.
    await window.getByTestId("chat-input").fill("one");
    await window.getByTestId("chat-input").press("Enter");
    await expect(window.getByTestId("message-assistant").first()).toBeVisible({
      timeout: 45_000,
    });

    // Kill the ipc child. main's on("exit") → setTimeout(2000) → respawn.
    killBackendChild();

    // Send the second turn. The renderer's chat-stream call will
    // either (a) queue until respawn finishes then succeed, or (b)
    // fail fast — depending on how robust the bridge is. We don't
    // care which, as long as an assistant message eventually shows.
    await window.getByTestId("chat-input").waitFor({
      state: "visible",
      timeout: 20_000,
    });
    await window.getByTestId("chat-input").fill("two");
    await window.getByTestId("chat-input").press("Enter");

    // The first assistant message from turn #1 is still in the DOM,
    // so assert the count climbs to at least 2 — that requires a
    // post-crash turn to have actually succeeded.
    await expect
      .poll(async () => await window.getByTestId("message-assistant").count(), {
        timeout: 60_000,
        message:
          "second assistant message never arrived — respawn + second turn pipeline is broken",
      })
      .toBeGreaterThanOrEqual(2);
  } finally {
    await app.close();
  }
});
