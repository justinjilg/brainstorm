/**
 * Incident trap — sendToBackend silently drops writes during respawn.
 *
 * History: during the ~2s gap between a backend crash and its
 * auto-respawn, `sendToBackend` would hit `backend?.stdin?.writable`
 * === false and silently discard the message. After recovery, the
 * renderer's next chat.stream call got no message delivered to the
 * fresh child; the UI sat at "thinking" for the full 5-minute stream
 * timeout. The fix: bounded `pendingOutbound` queue that holds writes
 * while `backendReady` is false and flushes in order on the next
 * `{type:"ready"}` signal.
 *
 * This is a narrower, faster cousin of
 * `../backend-crash.live.spec.ts`. That test is the broad "backend
 * crash recovery works" flow; this file pins the specific silent-drop
 * bug to a named incident trap so even if the broader flow test
 * evolves, the regression guard survives.
 */

import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { closeCleanly, launchBrainstormApp } from "../_helpers.js";

function killBackendChild(): void {
  try {
    execFileSync("pkill", ["-9", "-f", "brainstorm ipc"], { stdio: "ignore" });
  } catch {
    /* pkill exits 1 when no match — harmless */
  }
}

test("next chat turn lands even when backend is mid-respawn", async ({}, testInfo) => {
  testInfo.setTimeout(120_000);
  const { app, window } = await launchBrainstormApp();
  try {
    // Prime the session with a successful turn so we're sure we're
    // not testing cold-start behavior.
    await window.getByTestId("chat-input").fill("first");
    await window.getByTestId("chat-input").press("Enter");
    await expect(window.getByTestId("message-assistant").first()).toBeVisible({
      timeout: 45_000,
    });

    // Kill the backend. main's on("exit") fires, backendReady flips
    // false, setTimeout(2000) schedules respawn.
    killBackendChild();

    // Immediately send a second turn. The write hits sendToBackend
    // while the backend is null — pre-fix, this message would silently
    // disappear. Post-fix, it gets queued and flushed on ready.
    await window.getByTestId("chat-input").waitFor({
      state: "visible",
      timeout: 20_000,
    });
    await window.getByTestId("chat-input").fill("after-respawn");
    await window.getByTestId("chat-input").press("Enter");

    // If the queue works, we'll see a second assistant message arrive
    // once the new backend finishes booting and drains the queue.
    await expect
      .poll(async () => await window.getByTestId("message-assistant").count(), {
        timeout: 60_000,
        message:
          "post-respawn turn never received a reply — sendToBackend may be dropping writes again",
      })
      .toBeGreaterThanOrEqual(2);
  } finally {
    await closeCleanly(app);
  }
});
