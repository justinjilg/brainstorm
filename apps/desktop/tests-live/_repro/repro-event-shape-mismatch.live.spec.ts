/**
 * Incident trap — IPC event shape mismatch between main.ts and useChat.
 *
 * History: main.ts forwarded NDJSON events from the backend to the
 * renderer as `{id, event: "text-delta", data: {delta: "..."}}`, but
 * every consumer (useChat, trace view, etc.) discriminated on
 * `.type`, not `.event`. The result: every chat turn completed on
 * the backend, but `switch (event.type)` never matched a case, and
 * the UI flickered "thinking" and then cleared with no reply ever
 * landing. The fix: `normalizeChatEvent` in `src/lib/ipc-protocol.ts`,
 * applied at the bridge in `src/lib/ipc-client.ts`.
 *
 * The unit-level contract is tested exhaustively in
 * `tests-protocol/ipc-protocol.test.ts`. This file exists to guard
 * the *end-to-end* integration: the renderer must correctly surface
 * assistant text under the real Electron + IPC + backend path. A
 * regression that bypassed normalizeChatEvent at the bridge would
 * pass the protocol tests but fail this one.
 */

import { test, expect } from "@playwright/test";
import { closeCleanly, launchBrainstormApp } from "../_helpers.js";

test("chat text-delta events render end-to-end (normalize at bridge)", async () => {
  const { app, window } = await launchBrainstormApp();
  try {
    await window.getByTestId("chat-input").fill("hello");
    await window.getByTestId("chat-input").press("Enter");

    const assistant = window.getByTestId("message-assistant").first();
    await expect(assistant).toBeVisible({ timeout: 45_000 });

    // The bug shape this guards against: assistant bubble mounts but
    // has empty content because text-delta events never matched the
    // switch. The chat.live.spec.ts guard also checks `length > 1`;
    // here we go one character further and require actual words, since
    // a model might in theory reply with punctuation alone.
    const text = (await assistant.innerText()).trim();
    expect(
      /\w{2,}/.test(text),
      `assistant message has no word content — text-delta normalization may be broken`,
    ).toBe(true);
  } finally {
    await closeCleanly(app);
  }
});
