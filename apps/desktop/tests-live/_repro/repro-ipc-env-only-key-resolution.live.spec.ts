/**
 * Incident trap — `brainstorm ipc` resolved keys from env only.
 *
 * History: the ipc subcommand in packages/cli/src/bin/brainstorm.ts
 * shortcut the provider-key resolution to `process.env[NAME]`, skipping
 * the vault → 1Password → env resolver chain the rest of the CLI uses.
 * Result: the desktop app inherited `OP_SERVICE_ACCOUNT_TOKEN` from
 * the shell, expected the CLI to pull keys from 1Password on demand,
 * and got "No models available" on every chat turn. The fix: wire
 * `resolveProviderKeys()` into the ipc command so it traverses the
 * same resolver chain as `brainstorm run`.
 *
 * This trap goes a different route than chat.live.spec.ts:
 *   · chat.live.spec.ts asserts "a chat reply arrives" given whatever
 *     the current environment provides.
 *   · this file sends chat with provider-specific env vars STRIPPED,
 *     verifying the resolver chain pulls from 1Password (or falls
 *     back to whatever remains). If someone regresses the ipc command
 *     back to env-only, the chat either fails or the test's preface
 *     assertion catches it.
 *
 * Pre-req: `OP_SERVICE_ACCOUNT_TOKEN` is set in the shell env that
 * runs the test (our standard 1Password setup). Without it, this
 * test is skipped — we assert the capability is present rather than
 * failing on a machine where 1Password isn't configured at all.
 */

import { test, expect, _electron as electron } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoOrphanBackends, pickAppWindow } from "../_helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = join(__dirname, "..", "..");
const WORKSPACE_BIN = join(DESKTOP_ROOT, "..", "..", "node_modules", ".bin");

const PROVIDER_KEY_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "DEEPSEEK_API_KEY",
  "MOONSHOT_API_KEY",
  "BRAINSTORMROUTER_API_KEY",
];

test("ipc subcommand pulls keys through the vault resolver chain, not env-only", async ({}, testInfo) => {
  testInfo.setTimeout(90_000);

  if (!process.env.OP_SERVICE_ACCOUNT_TOKEN) {
    test.skip(
      true,
      "OP_SERVICE_ACCOUNT_TOKEN not set — skip; this trap requires 1Password",
    );
  }

  // Strip every provider-specific env var so the child process can
  // ONLY succeed if the resolver chain reaches 1Password. If the ipc
  // command reverts to env-only, chat will fail with "No models
  // available" and the assistant message never arrives.
  const patchedPath = `${WORKSPACE_BIN}:${process.env.PATH ?? ""}`;
  const strippedEnv: Record<string, string | undefined> = {
    ...process.env,
    PATH: patchedPath,
  };
  for (const key of PROVIDER_KEY_VARS) strippedEnv[key] = undefined;

  const app = await electron.launch({
    args: [DESKTOP_ROOT],
    env: Object.fromEntries(
      Object.entries(strippedEnv).filter(([, v]) => v !== undefined),
    ) as Record<string, string>,
  });
  try {
    const window = await pickAppWindow(app);
    await expect(window.getByTestId("boot-splash")).toBeHidden({
      timeout: 30_000,
    });
    await expect(window.getByTestId("app-root")).toBeVisible({
      timeout: 10_000,
    });

    await window.getByTestId("chat-input").fill("hi");
    await window.getByTestId("chat-input").press("Enter");

    await expect(
      window.getByTestId("message-assistant").first(),
      "no assistant message with 1Password-only keys — resolver chain broke",
    ).toBeVisible({ timeout: 60_000 });
  } finally {
    await app.close();
    await new Promise((r) => setTimeout(r, 500));
    assertNoOrphanBackends();
  }
});
