/**
 * Drain-after-interrupt live e2e.
 *
 * The Vercel AI SDK and Claude Agent SDK both warn that after an
 * abort, the session buffer holds a terminal ResultMessage that the
 * client must drain before its next query, or stale tokens leak into
 * the next bubble — or worse, the next turn hangs waiting for a
 * stream-end that will never come because the buffer blocked the
 * next request's processing.
 *
 * In pass 4 I observed exactly that symptom: after aborting a long
 * essay prompt, sending "hi" never produced an assistant reply. This
 * spec is the regression trap for that class: after an abort the
 * session must drain cleanly and the very next turn must work.
 *
 * This is the SECOND half of abort.live.spec.ts — that one guards
 * "Stop stops the stream", this one guards "the session isn't poisoned
 * by the abort."
 */

import { test, expect } from "@playwright/test";
import { closeCleanly, launchBrainstormApp } from "./_helpers.js";

test("drain-after-interrupt: turn after abort completes cleanly", async ({}, testInfo) => {
  testInfo.setTimeout(180_000);

  const { app, window } = await launchBrainstormApp();
  try {
    // Force a long-streaming first turn so Stop is guaranteed to be
    // visible by the time we click it.
    await window
      .getByTestId("chat-input")
      .fill(
        "Please write a richly detailed 3000-word essay on the full history " +
          "of bronze-age metallurgy across five regions. Use long paragraphs.",
      );
    await window.getByTestId("chat-input").press("Enter");

    const stopBtn = window.getByTestId("stop-button");
    await expect(stopBtn).toBeVisible({ timeout: 15_000 });
    await stopBtn.click();

    // Wait for the UI to settle out of processing state. If this
    // doesn't flip, isProcessing stays true and the next send is a
    // no-op — that's one failure mode to catch.
    await expect(window.getByTestId("chat-input")).toBeEnabled({
      timeout: 10_000,
    });
    await expect(stopBtn).toBeHidden({ timeout: 10_000 });

    // Send a fresh turn. We count assistant messages before and after
    // so a slow model doesn't confuse us with a still-pending delta
    // from the previous turn.
    const beforeCount = await window.getByTestId("message-assistant").count();

    const marker = `drain-${Date.now().toString(36)}`;
    await window.getByTestId("chat-input").fill(marker);
    await window.getByTestId("chat-input").press("Enter");

    // The user message for the marker must mount.
    await expect(
      window.getByTestId("message-user").filter({ hasText: marker }),
    ).toBeVisible({ timeout: 5_000 });

    // Eventually an additional assistant message arrives. If the
    // session is poisoned / buffer not drained, this times out.
    await expect
      .poll(async () => await window.getByTestId("message-assistant").count(), {
        timeout: 60_000,
        message:
          "post-abort turn hung — the session buffer wasn't drained after the interrupt " +
          "(Vercel AI / Claude Agent SDK buffer-drain contract). See tests-live/README.",
      })
      .toBeGreaterThan(beforeCount);
  } finally {
    await closeCleanly(app);
  }
});
