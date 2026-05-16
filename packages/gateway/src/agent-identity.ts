/**
 * Agent identity persistence — per-install CLI agent_id management.
 *
 * The CLI's BrainstormRouter integration was using only the community key
 * (or operator's API key), with `agent_id` returning null from /v1/self.
 * That meant no per-agent reputation tier, no agent-scoped budgets, no
 * per-agent JWT, no audit trail keyed on the agent.
 *
 * This module:
 *   1. Generates a stable agent_id on first install: `brainstorm-cli-<8-hex>`.
 *      Matches BR's pattern: 3-64 lowercase alphanumeric + hyphens.
 *   2. Persists it to `~/.brainstorm/agent.json` (chmod 600 — operator-only).
 *   3. The bootstrap call returns a JWT — we DELIBERATELY DO NOT persist
 *      the JWT. It's a 1-hour token; cache in-memory for the session, then
 *      re-bootstrap on next CLI startup (idempotent on BR side).
 *
 * Closes v14 risk register cite "Agent never claims an agent_id"
 * (4 of 10 agents flagged). Drives Path-to-90 D6.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { isValidAgentId } from "./client.js";

/** Where the agent identity file lives. */
const DEFAULT_AGENT_FILE = join(
  process.env.BRAINSTORM_HOME ?? join(homedir(), ".brainstorm"),
  "agent.json",
);

/** Persisted shape — JUST the stable agent_id + when we created it.
 *  The JWT and profile from BR are NOT persisted here. */
export interface StoredAgentIdentity {
  agentId: string;
  createdAt: string;
  /** Optional: display name shown in BR's UI. */
  displayName?: string;
  /** Optional: BR's profile.id (UUID) returned on first bootstrap.
   *  Cached for reference; not load-bearing — bootstrap is keyed on
   *  agent_id, not profile.id. */
  brProfileId?: string;
}

/**
 * Load the agent_id from disk if it exists, else generate a new one
 * and persist it. Always returns a valid agent_id.
 */
export function loadOrCreateAgentIdentity(
  filePath: string = DEFAULT_AGENT_FILE,
): StoredAgentIdentity {
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(
        readFileSync(filePath, "utf-8"),
      ) as StoredAgentIdentity;
      if (parsed.agentId && isValidAgentId(parsed.agentId)) {
        return parsed;
      }
      // Fall through: file exists but is corrupt or has an invalid ID.
      // Don't refuse — generate a fresh one. (Operator may have edited it.)
    } catch {
      // Corrupt JSON; regenerate.
    }
  }
  const identity: StoredAgentIdentity = {
    agentId: generateAgentId(),
    createdAt: new Date().toISOString(),
    displayName: defaultDisplayName(),
  };
  saveAgentIdentity(identity, filePath);
  return identity;
}

/**
 * Persist agent identity to disk with restrictive perms (0600).
 * Creates the parent dir if missing.
 */
export function saveAgentIdentity(
  identity: StoredAgentIdentity,
  filePath: string = DEFAULT_AGENT_FILE,
): void {
  const dir = join(filePath, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(identity, null, 2), "utf-8");
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // chmod fails on some filesystems (windows, mounted NFS w/o suid).
    // The default umask + parent dir perms are still reasonable.
  }
}

/**
 * Generate a new agent_id matching BR's pattern.
 * Shape: `brainstorm-cli-<16-hex>` (28 chars total — fits 3-64 with room).
 *
 * Using random bytes (not just a UUID-derived) keeps the ID short while
 * avoiding the cross-install collision risk a counter would introduce.
 */
export function generateAgentId(): string {
  const suffix = randomBytes(8).toString("hex"); // 16 lowercase hex chars
  return `brainstorm-cli-${suffix}`;
}

/** Hostname-derived display name; trimmed and length-capped. */
function defaultDisplayName(): string {
  try {
    // node:os.hostname is allowed in node, but optional — we don't fail
    // if it's unavailable.
    const os = require("node:os") as { hostname?: () => string };
    const host = os.hostname?.() ?? "unknown";
    return `brainstorm-cli@${host.slice(0, 40)}`;
  } catch {
    return "brainstorm-cli";
  }
}
