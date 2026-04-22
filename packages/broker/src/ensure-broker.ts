/**
 * Broker auto-spawn helper.
 *
 * Called by storm CLI boot (or any future consumer). Checks /health — if the
 * broker is up, returns fast. If not, spawns `brainstorm-broker` as a
 * detached child and waits up to 6s for it to become reachable.
 *
 * Detached + unref'd so the broker outlives the CLI process that started it.
 * Subsequent CLI sessions find it already running.
 */

import { spawn } from "node:child_process";
import { createLogger } from "@brainst0rm/shared";
import { DEFAULT_BROKER_PORT } from "./daemon.js";

const log = createLogger("broker-ensure");

export interface EnsureBrokerOptions {
  port?: number;
  /** Explicit path to the broker binary. Default resolves via require.resolve semantics. */
  binPath?: string;
  /** Max wait for the broker to come up after spawn. Default 6s. */
  startupTimeoutMs?: number;
}

export async function isBrokerAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(1_500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ensure the broker is reachable. Returns the port it's listening on.
 * Idempotent — no-ops if already alive.
 */
export async function ensureBroker(
  opts: EnsureBrokerOptions = {},
): Promise<number> {
  const port = opts.port ?? DEFAULT_BROKER_PORT;
  const timeoutMs = opts.startupTimeoutMs ?? 6_000;

  if (await isBrokerAlive(port)) return port;

  const binPath = opts.binPath ?? resolveBrokerBin();
  if (!binPath) {
    throw new Error(
      "broker binary not found; pass binPath explicitly or build @brainst0rm/broker",
    );
  }

  log.debug({ binPath, port }, "spawning broker");
  const child = spawn(process.execPath, [binPath], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, BRAINSTORM_BROKER_PORT: String(port) },
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  const pollEvery = 200;
  while (Date.now() < deadline) {
    if (await isBrokerAlive(port)) return port;
    await new Promise((r) => setTimeout(r, pollEvery));
  }
  throw new Error(
    `broker did not become reachable on :${port} within ${timeoutMs}ms`,
  );
}

function resolveBrokerBin(): string | null {
  // Resolve relative to this module — works whether we're running from
  // dist/ (bundled) or src/ (tests).
  try {
    const here = new URL(import.meta.url).pathname;
    // When running from dist, here is /.../broker/dist/ensure-broker.js.
    // The bin entry is /.../broker/dist/bin.js.
    return here.replace(/[^/]+$/, "bin.js");
  } catch {
    return null;
  }
}
