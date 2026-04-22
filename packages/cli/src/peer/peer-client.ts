/**
 * CLI-side peer coordination glue — wraps @brainst0rm/broker for storm CLI.
 *
 * Responsibilities (kept narrow so the rest of the CLI doesn't need to
 * know about the broker internals):
 *
 *   1. Discover a suitable BRAINSTORM_ROUTER_API_KEY — the broker's tenant
 *      boundary is derived from it via a sha256 fingerprint. If missing,
 *      peer coordination is disabled silently (returns null).
 *   2. Ensure the broker daemon is running (auto-spawn if needed).
 *   3. Register this process with the broker and start heartbeat + inbound
 *      message polling.
 *   4. Emit a summary so other sessions see meaningful context in list_peers.
 *   5. Clean unregister on process exit.
 *
 * The returned `ActivePeer` is what the rest of the CLI uses — list, send,
 * update summary, subscribe to incoming messages. Designed so that a null
 * return (peer coordination disabled) is easy to ignore — callers check
 * for null and skip peer operations.
 */

import { execFileSync } from "node:child_process";
import {
  BrokerClient,
  ensureBroker,
  type Peer,
  type PeerScope,
} from "@brainst0rm/broker";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("peer-client");

export interface StartPeerOptions {
  /** Directory the CLI was invoked from. Used for `directory` scope discovery. */
  cwd: string;
  /** Optional summary shown to other peers in list_peers. */
  summary?: string;
  /**
   * Resolved API key (usually `process.env.BRAINSTORM_ROUTER_API_KEY`).
   * When undefined or empty, peer coordination is disabled.
   */
  apiKey?: string;
}

export interface ActivePeer {
  id: string;
  fingerprint: string;
  listPeers: (scope?: PeerScope) => Promise<Peer[]>;
  sendMessage: (toId: string, text: string) => Promise<void>;
  setSummary: (summary: string) => Promise<void>;
  onMessage: (
    cb: (msg: {
      id: number;
      from_id: string;
      to_id: string;
      text: string;
      sent_at: string;
    }) => void | Promise<void>,
  ) => () => void;
  shutdown: () => Promise<void>;
}

/**
 * Best-effort launcher. Returns null if peer coordination is disabled
 * (no API key) or if the broker can't be spawned for some reason. Never
 * throws — a broken broker shouldn't take down the CLI.
 */
export async function startPeerCoordination(
  opts: StartPeerOptions,
): Promise<ActivePeer | null> {
  const apiKey = opts.apiKey ?? process.env.BRAINSTORM_ROUTER_API_KEY;
  if (!apiKey) {
    log.debug("peer coordination disabled — no BRAINSTORM_ROUTER_API_KEY");
    return null;
  }

  try {
    const port = await ensureBroker();
    const client = new BrokerClient({
      port,
      apiKey,
      pid: process.pid,
      cwd: opts.cwd,
      git_root: detectGitRoot(opts.cwd),
      tty: detectTty(),
      summary: opts.summary ?? "",
    });
    const id = await client.start();

    const shutdown = async (): Promise<void> => {
      try {
        await client.stop();
      } catch (err) {
        log.debug(
          { err: err instanceof Error ? err.message : String(err) },
          "peer shutdown error (non-fatal)",
        );
      }
    };

    // Best-effort cleanup on normal exits.
    process.once("exit", () => {
      void shutdown();
    });

    log.info(
      {
        peerId: id,
        fingerprint: client.getFingerprint(),
        port,
      },
      "peer coordination active",
    );

    return {
      id,
      fingerprint: client.getFingerprint(),
      listPeers: (scope = "machine") => client.listPeers(scope),
      sendMessage: (toId, text) => client.sendMessage(toId, text),
      setSummary: (s) => client.setSummary(s),
      onMessage: (cb) => client.onMessage(cb),
      shutdown,
    };
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "peer coordination unavailable",
    );
    return null;
  }
}

function detectGitRoot(cwd: string): string | null {
  // execFileSync does NOT spawn a shell — the args are passed directly to
  // the git binary without interpolation. Safe for fixed commands with no
  // caller-controlled arguments.
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function detectTty(): string | null {
  // Parent PID is a process-local integer — safe argument. Still using
  // execFileSync (shell-free) belt and suspenders.
  try {
    const out = execFileSync("ps", ["-o", "tty=", "-p", String(process.ppid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const tty = out.trim();
    if (!tty || tty === "?" || tty === "??") return null;
    return tty;
  } catch {
    return null;
  }
}
