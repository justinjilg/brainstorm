/**
 * Conversation persistence live e2e.
 *
 * Audit item H2: `conversationId` was being stripped by the Zod schema,
 * so every chat turn opened a fresh session. The sidebar showed "same
 * conversation" but every message was a new thread. This test is the
 * regression trap: send a marker turn in one session, reload the app
 * into the SAME BRAINSTORM_HOME, pick the conversation from the
 * sidebar, and assert the marker user message rehydrates from the DB.
 *
 * Uses the test-owned BRAINSTORM_HOME in `_helpers.ts` so the two
 * launches share a fresh sqlite DB that no other spec touches. Before
 * we added isolation this test would pick the wrong "first
 * conversation" row on reload depending on what ran earlier in the
 * full suite.
 */

import { expect, test, _electron as electron } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoOrphanBackends,
  pickAppWindow,
  WORKSPACE_BIN,
} from "./_helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = join(__dirname, "..");

test("conversation persistence: messages rehydrate after app restart", async ({}, testInfo) => {
  testInfo.setTimeout(120_000);

  // Shared BRAINSTORM_HOME across BOTH launches so the second session
  // sees what the first session wrote. Fresh tmpdir so no other spec
  // (past or parallel) can pollute it.
  const home = mkdtempSync(join(tmpdir(), "brainstorm-live-persist-"));
  const launchEnv: Record<string, string> = {
    ...process.env,
    PATH: `${WORKSPACE_BIN}:${process.env.PATH ?? ""}`,
    BRAINSTORM_HOME: home,
  };
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

    await window.getByTestId("new-conversation").click();

    // Because this test has an isolated DB, the new conversation is
    // the ONLY conversation in the sidebar — `.first()` picks it
    // unambiguously.
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
    // the DB before we tear down.
    await expect(window.getByTestId("message-assistant").first()).toBeVisible({
      timeout: 45_000,
    });
  } finally {
    await app1.close();
    await new Promise((r) => setTimeout(r, 500));
    assertNoOrphanBackends();
  }

  expect(
    rememberedConversationId,
    "first session should've produced a conversation row",
  ).toBeTruthy();

  // ── Second session: relaunch against SAME home, assert rehydrate ──
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

    const userMsg = window
      .getByTestId("message-user")
      .filter({ hasText: marker });
    await expect(
      userMsg.first(),
      `marker ${marker} should be rehydrated from DB`,
    ).toBeVisible({ timeout: 10_000 });
  } finally {
    await app2.close();
    await new Promise((r) => setTimeout(r, 500));
    assertNoOrphanBackends();
  }
});
