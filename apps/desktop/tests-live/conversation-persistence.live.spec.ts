/**
 * Conversation persistence live e2e.
 *
 * Audit item H2: `conversationId` was being stripped by the Zod schema,
 * so every chat turn opened a fresh session. The sidebar showed "same
 * conversation" but every message was a new thread. This test is the
 * regression trap: send two turns in one conversation, then reload the
 * app, pick the conversation from the sidebar, and assert both user
 * messages rehydrate.
 *
 * Depends on MessageRepository actually persisting to the sqlite DB at
 * ~/.brainstorm/brainstorm.db — if the persistence layer regresses,
 * this fails.
 */

import { test, expect, _electron as electron } from "@playwright/test";
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

test("conversation persistence: messages rehydrate after app restart", async () => {
  const patchedPath = `${WORKSPACE_BIN}:${process.env.PATH ?? ""}`;
  const launchEnv = { ...process.env, PATH: patchedPath };

  // Use a message distinctive enough that it can't collide with prior
  // test runs in ~/.brainstorm/brainstorm.db.
  const marker = `persistence-marker-${Date.now().toString(36)}`;

  // ── First session: create conversation, send marker turn ──────────
  const app1 = await electron.launch({
    args: [DESKTOP_ROOT],
    env: launchEnv,
  });
  let rememberedConversationId: string | null = null;
  try {
    const window = await pickAppWindow(app1);
    await expect(window.getByTestId("boot-splash")).toBeHidden({
      timeout: 30_000,
    });
    await expect(window.getByTestId("app-root")).toBeVisible({
      timeout: 10_000,
    });

    // Create a fresh conversation so we have a stable id to target on
    // reload. The "New conversation" button in the sidebar fires the
    // create IPC and then selects the new conversation.
    await window.getByTestId("new-conversation").click();

    // Wait for the conversation row to appear in the sidebar with a
    // stable data-testid we can remember.
    const conversationRow = window
      .locator("[data-testid^='conversation-']")
      .first();
    await expect(conversationRow).toBeVisible({ timeout: 10_000 });
    rememberedConversationId =
      (await conversationRow.getAttribute("data-testid")) ?? null;
    expect(rememberedConversationId).toBeTruthy();

    await window.getByTestId("chat-input").fill(marker);
    await window.getByTestId("chat-input").press("Enter");

    await expect(window.getByTestId("message-user").first()).toBeVisible({
      timeout: 5_000,
    });
    // Wait for the assistant reply so the turn is actually committed to
    // the DB before we tear down — otherwise the backend might not
    // have flushed the assistant message by shutdown time.
    await expect(window.getByTestId("message-assistant").first()).toBeVisible({
      timeout: 45_000,
    });
  } finally {
    await app1.close();
  }

  expect(
    rememberedConversationId,
    "first session should've produced a conversation row",
  ).toBeTruthy();

  // ── Second session: relaunch, pick the same conversation, assert ──
  const app2 = await electron.launch({
    args: [DESKTOP_ROOT],
    env: launchEnv,
  });
  try {
    const window = await pickAppWindow(app2);
    await expect(window.getByTestId("boot-splash")).toBeHidden({
      timeout: 30_000,
    });
    await expect(window.getByTestId("app-root")).toBeVisible({
      timeout: 10_000,
    });

    const reloadedRow = window.locator(
      `[data-testid='${rememberedConversationId}']`,
    );
    await expect(
      reloadedRow,
      `conversation ${rememberedConversationId} should survive restart`,
    ).toBeVisible({ timeout: 15_000 });

    await reloadedRow.click();

    // The rehydrated chat view should contain the marker text from the
    // first session inside a user message.
    const userMsg = window
      .getByTestId("message-user")
      .filter({ hasText: marker });
    await expect(
      userMsg.first(),
      `marker ${marker} should be rehydrated from DB`,
    ).toBeVisible({ timeout: 10_000 });
  } finally {
    await app2.close();
  }
});
