/**
 * Teardown hygiene live e2e.
 *
 * Launches the app, runs one chat turn (so a `brainstorm ipc` child is
 * definitely spawned), closes, and asserts no orphan ipc process
 * survives. This is the sentinel that proves closeCleanly() works on
 * the actual happy-path flow — the other live specs call
 * closeCleanly() in finally{} and rely on this test's existence.
 *
 * Guards against a class of teardown bug the existing suite wouldn't
 * catch: a backend child that silently escapes from `app.close()` (e.g.
 * if main's before-quit cleanup regresses, or if the respawn loop
 * outruns the shutdown signal). Without this check, every test "passes"
 * while leaking a process that sits around burning RAM + billing
 * against any cloud budgets until the user logs out.
 */

import { test, expect } from "@playwright/test";
import { closeCleanly, launchBrainstormApp } from "./_helpers.js";

test("teardown hygiene: closing the app leaves no orphan brainstorm ipc", async () => {
  const { app, window } = await launchBrainstormApp();
  try {
    // Do something that forces a working backend, not just a ready
    // signal — this is the bug shape we're trapping: "app closes OK
    // as long as the backend never actually did anything."
    await window.getByTestId("chat-input").fill("hi");
    await window.getByTestId("chat-input").press("Enter");
    await expect(window.getByTestId("message-assistant").first()).toBeVisible({
      timeout: 45_000,
    });
  } finally {
    // closeCleanly throws if a child process survives.
    await closeCleanly(app);
  }
});
