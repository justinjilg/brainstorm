/**
 * Wire-level types shared between the broker daemon and its clients.
 *
 * Kept separate from internal DB row shapes so the on-disk schema can change
 * without breaking clients — the fields below are what goes over HTTP.
 */

/** Opaque identifier the broker assigns on register. */
export type PeerId = string;

/**
 * Scope of `list-peers` discovery.
 *
 * `machine` — every live peer on this host sharing the caller's auth fingerprint
 * `directory` — peers whose cwd equals the caller's cwd
 * `repo` — peers whose git_root equals the caller's git_root (falls back to directory when git_root is null)
 */
export type PeerScope = "machine" | "directory" | "repo";

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  /**
   * sha256(BRAINSTORM_API_KEY).slice(0,16). Used as a tenant boundary: peers
   * only see other peers with the same fingerprint, and messages between
   * mismatched fingerprints are rejected. Never the raw key.
   */
  auth_fingerprint: string;
  registered_at: string;
  last_seen: string;
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string;
}

// ── Request / Response types ───────────────────────────────────────────

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  auth_fingerprint: string;
}

export interface RegisterResponse {
  id: PeerId;
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface ListPeersRequest {
  scope: PeerScope;
  /** Caller's own id so the response can exclude it. */
  caller_id: PeerId;
  /** Caller's auth fingerprint — peers outside the caller's tenant are hidden. */
  auth_fingerprint: string;
  /** Caller's cwd (used by `directory` scope). */
  cwd: string;
  /** Caller's git_root (used by `repo` scope, nullable). */
  git_root: string | null;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  /** Caller's fingerprint; broker enforces from_id's stored fingerprint matches this AND the target's. */
  auth_fingerprint: string;
}

export interface SendMessageResponse {
  ok: boolean;
  error?: string;
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}

export interface UnregisterRequest {
  id: PeerId;
}

export interface HealthResponse {
  status: "ok";
  peers: number;
  version: string;
}
