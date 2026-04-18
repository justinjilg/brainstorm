/**
 * Shared test utilities for the live-backend harness.
 *
 * Each live spec should:
 *  - call `launchBrainstormApp()` to spawn Electron with the workspace
 *    CLI on PATH and return a ready-to-use app + window handle
 *  - call `assertNoOrphanBackends()` once at the end to prove the tear-
 *    down path didn't leak a `brainstorm ipc` child process into the
 *    system. The existing specs would not have caught a respawn-loop
 *    bug that leaves orphans; this does.
 */

import { expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DESKTOP_ROOT = join(__dirname, "..");
export const WORKSPACE_BIN = join(
  DESKTOP_ROOT,
  "..",
  "..",
  "node_modules",
  ".bin",
);

export interface LaunchedApp {
  app: ElectronApplication;
  window: Page;
}

/**
 * Spawn Electron with the workspace brainstorm CLI ahead of PATH, wait
 * for the app window (not the DevTools sibling), and confirm the main
 * shell has mounted past the boot splash.
 */
export async function launchBrainstormApp(): Promise<LaunchedApp> {
  const patchedPath = `${WORKSPACE_BIN}:${process.env.PATH ?? ""}`;
  const app = await electron.launch({
    args: [DESKTOP_ROOT],
    env: { ...process.env, PATH: patchedPath },
  });

  const window = await pickAppWindow(app);
  await expect(window.getByTestId("boot-splash")).toBeHidden({
    timeout: 30_000,
  });
  await expect(window.getByTestId("app-root")).toBeVisible({
    timeout: 10_000,
  });
  return { app, window };
}

/**
 * Electron often creates a detached DevTools window alongside the app
 * window, and `app.firstWindow()` can return either depending on which
 * finished loading first. Pick the app window explicitly by URL.
 */
export async function pickAppWindow(
  app: ElectronApplication,
  timeoutMs = 15_000,
): Promise<Page> {
  const isAppWindow = (url: string) =>
    url.startsWith("http://localhost:1420") || url.includes("/dist/index.html");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = app.windows().find((w) => isAppWindow(w.url()));
    if (match) return match;
    await app.waitForEvent("window", { timeout: 2_000 }).catch(() => null);
  }
  throw new Error(
    `Brainstorm window never appeared. Current windows: ${app
      .windows()
      .map((w) => w.url())
      .join(", ")}`,
  );
}

/**
 * Assert that closing the Electron app leaves no `brainstorm ipc`
 * child processes behind. Intentionally tolerant of the "no processes
 * at all" case: pgrep returns 1 when nothing matches, and that's the
 * state we want.
 *
 * Called in finally{} after app.close() in each live spec. If a new
 * teardown bug ever leaves a zombie backend running indefinitely, this
 * surfaces it instead of silently wasting the user's laptop cycles.
 */
export function assertNoOrphanBackends(): void {
  let pids = "";
  try {
    pids = execFileSync("pgrep", ["-f", "brainstorm ipc"], {
      encoding: "utf-8",
    }).trim();
  } catch (err) {
    // pgrep exits 1 when no matches — that's the happy path. Only
    // rethrow when it exits with some OTHER error (e.g. pgrep missing).
    const e = err as { status?: number; message?: string };
    if (e.status === 1) return;
    throw new Error(`pgrep failed unexpectedly: ${e.message}`);
  }
  if (pids.length > 0) {
    // Best-effort clean up so the next test in the suite isn't
    // contaminated, THEN fail loudly.
    try {
      execFileSync("pkill", ["-9", "-f", "brainstorm ipc"], {
        stdio: "ignore",
      });
    } catch {
      /* swallow — we're about to throw anyway */
    }
    throw new Error(
      `orphan brainstorm ipc processes survived app.close(): pids=${pids.replace(/\n/g, ",")}`,
    );
  }
}

/**
 * Standard tear-down: close app, then assert no orphans. Use in place
 * of `await app.close()` in finally blocks.
 */
export async function closeCleanly(app: ElectronApplication): Promise<void> {
  await app.close();
  // Small grace period — pgrep can catch the child while it's
  // still exiting. 500ms is generous but harmless.
  await new Promise((r) => setTimeout(r, 500));
  assertNoOrphanBackends();
}
