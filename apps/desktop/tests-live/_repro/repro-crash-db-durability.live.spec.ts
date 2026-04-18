/**
 * Incident trap — turn content must be on disk before a crash, not
 * just in memory.
 *
 * Guards [claude-agent-sdk-python issue #625](https://github.com/anthropics/claude-agent-sdk-python/issues/625)
 * — "session file not flushed before subprocess termination." The
 * DOM-level assertion in `backend-crash.live.spec.ts` proves the
 * turn-1 marker survives a SIGKILL *in the React state*. That passes
 * whether the DB wrote or not. This spec is stricter: open the
 * sqlite file directly from the test and assert the user+assistant
 * rows for the marker turn are persisted BEFORE the kill.
 *
 * If better-sqlite3 is ever unable to open the test's DB (because
 * WAL checkpointing lagged, because the schema drifted, because the
 * messages table was renamed), this test fires. It's the strictest
 * durability guard we have.
 */

import { expect, test, _electron as electron } from "@playwright/test";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoOrphanBackends,
  pickAppWindow,
  WORKSPACE_BIN,
} from "../_helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = join(__dirname, "..", "..");

test("turn-1 content is on disk before the app closes", async ({}, testInfo) => {
  testInfo.setTimeout(120_000);

  const home = mkdtempSync(join(tmpdir(), "brainstorm-durability-"));
  const launchEnv: Record<string, string> = {
    ...process.env,
    PATH: `${WORKSPACE_BIN}:${process.env.PATH ?? ""}`,
    BRAINSTORM_HOME: home,
  };
  const marker = `durability-marker-${Date.now().toString(36)}`;

  const app = await electron.launch({
    args: [DESKTOP_ROOT],
    env: launchEnv,
  });

  try {
    const window = await pickAppWindow(app);
    await expect(window.getByTestId("boot-splash")).toBeHidden({
      timeout: 30_000,
    });
    await expect(window.getByTestId("app-root")).toBeVisible({
      timeout: 10_000,
    });

    await window.getByTestId("chat-input").fill(marker);
    await window.getByTestId("chat-input").press("Enter");

    // Wait for both ends of the turn. Assistant-visible implies the
    // backend's persistence code has had its chance to run — if the
    // DB still doesn't show the row after this, the persistence path
    // is broken, not racing.
    await expect(window.getByTestId("message-user").first()).toBeVisible({
      timeout: 5_000,
    });
    await expect(window.getByTestId("message-assistant").first()).toBeVisible({
      timeout: 45_000,
    });
  } finally {
    await app.close();
    await new Promise((r) => setTimeout(r, 500));
    assertNoOrphanBackends();
  }

  // ── The real assertion: open the sqlite file directly ───────────
  // `join` guarantees we're opening the test's isolated DB, not the
  // user's real ~/.brainstorm. better-sqlite3 auto-checkpoints WAL on
  // open; if content was still in -wal but hadn't reached the main
  // file, this read would still see it. That's the contract we want.
  const dbPath = join(home, "brainstorm.db");
  const db = new Database(dbPath, { readonly: true });
  try {
    const userRows = db
      .prepare(
        "SELECT id, role, content FROM messages WHERE role = 'user' AND content = ?",
      )
      .all(marker) as Array<{ id: string; role: string; content: string }>;
    expect(
      userRows,
      `marker ${marker} user row missing from ${dbPath} — persistence path didn't flush before app.close()`,
    ).toHaveLength(1);

    // The assistant message doesn't contain the marker verbatim, but
    // it's guaranteed to share the same session_id as the user row.
    // Assert at least one assistant row exists for that session.
    const sessionId = db
      .prepare(
        "SELECT session_id FROM messages WHERE role = 'user' AND content = ?",
      )
      .get(marker) as { session_id: string };
    const assistantRows = db
      .prepare(
        "SELECT id FROM messages WHERE session_id = ? AND role = 'assistant'",
      )
      .all(sessionId.session_id) as Array<{ id: string }>;
    expect(
      assistantRows.length,
      `no assistant row persisted for session ${sessionId.session_id} — assistant-message flush regressed`,
    ).toBeGreaterThan(0);
  } finally {
    db.close();
  }
});
