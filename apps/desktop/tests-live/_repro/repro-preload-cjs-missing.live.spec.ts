/**
 * Incident trap — preload.cjs missing from build output.
 *
 * History: electron/main.ts references `preload.cjs` at
 * webPreferences.preload, but the build pipeline was only producing
 * `preload.js` (ESM). Electron silently skipped the missing file,
 * `window.brainstorm` was never injected, and the app rendered a
 * permanently-stuck BootSplash. The fix: commit `electron/preload.cjs`
 * as source of truth and add a `build:electron` step that copies it
 * into `electron/dist/preload.cjs`.
 *
 * This file is the incident-named regression trap for that bug. It
 * asserts the build artifact exists; if anyone deletes the cp step or
 * moves the preload file, `npm run test:protocol` fires.
 *
 * Incident category: file is technically a live-harness neighbor, but
 * the assertion is pure filesystem — no Electron launch needed.
 * Ideally should live in tests-protocol/ once we factor filesystem
 * contracts out; for now it sits with its siblings under _repro/ so
 * the naming discipline stays visible.
 */

import { test, expect } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = join(__dirname, "..", "..");

test("preload.cjs exists after build:electron", () => {
  const cjsPath = join(DESKTOP_ROOT, "electron", "dist", "preload.cjs");
  expect(
    existsSync(cjsPath),
    `electron/dist/preload.cjs missing — build:electron needs to cp it from electron/preload.cjs`,
  ).toBe(true);

  const contents = readFileSync(cjsPath, "utf-8");
  // Sanity: the CJS bridge must exist as a CommonJS require() shape,
  // not an ESM import. Electron's preload sandbox doesn't load ESM.
  expect(
    contents.includes("require(") && contents.includes("contextBridge"),
    "electron/dist/preload.cjs doesn't look like a CJS Electron preload — " +
      "did it get regenerated from TS with the wrong module target?",
  ).toBe(true);

  // And make sure it exposes the methods the renderer actually calls.
  // If someone adds a new bridge method but forgets to update preload.cjs
  // (since TS and CJS are out of sync by design), this test names the
  // contract.
  for (const method of [
    "request",
    "chatStream",
    "onChatEvent",
    "onBackendReady",
    "getBackendReady",
    "openFolder",
  ]) {
    expect(
      contents.includes(method),
      `preload.cjs is missing the \`${method}\` bridge method`,
    ).toBe(true);
  }
});
