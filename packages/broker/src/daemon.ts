/**
 * Local peer broker daemon — HTTP server + SQLite persistence.
 *
 * Mirrors `~/claude-peers-mcp/broker.ts` but differs in three ways that
 * matter for Phase 3:
 *
 *   1. Auth-fingerprint-scoped discovery + messaging. Each peer registers
 *      with a sha256(BRAINSTORM_API_KEY).slice(0,16) fingerprint. list-peers
 *      only returns peers with a matching fingerprint; send-message rejects
 *      if from or to peer's stored fingerprint disagrees with the request's.
 *      This is the cross-tenant boundary called out in the Phase 3 adversarial
 *      review.
 *
 *   2. Uses Node's `http` module and `better-sqlite3` (Node ecosystem), not
 *      Bun. Matches the rest of packages/*.
 *
 *   3. Factorable — `createBroker()` returns a controllable instance so tests
 *      can spin up a broker on an ephemeral port with in-memory SQLite.
 *
 * The broker has NO awareness of routing decisions or any domain logic. It
 * is a pure message-passing + peer-registry primitive. Higher-level uses
 * layer on top of the client.
 */

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createLogger } from "@brainst0rm/shared";
import Database, { type Database as DatabaseType } from "better-sqlite3";
import type {
  HealthResponse,
  HeartbeatRequest,
  ListPeersRequest,
  Message,
  Peer,
  PollMessagesRequest,
  PollMessagesResponse,
  RegisterRequest,
  RegisterResponse,
  SendMessageRequest,
  SendMessageResponse,
  SetSummaryRequest,
  UnregisterRequest,
} from "./types.js";

const log = createLogger("broker");

export const BROKER_VERSION = "0.13.0";
export const DEFAULT_BROKER_PORT = 7900;

// ── DB layer ───────────────────────────────────────────────────────────

interface PeerRow {
  id: string;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  auth_fingerprint: string;
  registered_at: string;
  last_seen: string;
}

interface MessageRow {
  id: number;
  from_id: string;
  to_id: string;
  text: string;
  sent_at: string;
  delivered: number;
}

function initSchema(db: DatabaseType): void {
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 3000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS peers (
      id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      git_root TEXT,
      tty TEXT,
      summary TEXT NOT NULL DEFAULT '',
      auth_fingerprint TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      last_seen TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_peers_fingerprint ON peers(auth_fingerprint);
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      text TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_messages_to_undelivered
      ON messages(to_id, delivered);
  `);
}

function toWirePeer(row: PeerRow): Peer {
  return {
    id: row.id,
    pid: row.pid,
    cwd: row.cwd,
    git_root: row.git_root,
    tty: row.tty,
    summary: row.summary,
    auth_fingerprint: row.auth_fingerprint,
    registered_at: row.registered_at,
    last_seen: row.last_seen,
  };
}

function toWireMessage(row: MessageRow): Message {
  return {
    id: row.id,
    from_id: row.from_id,
    to_id: row.to_id,
    text: row.text,
    sent_at: row.sent_at,
  };
}

// ── Broker factory ─────────────────────────────────────────────────────

export interface BrokerOptions {
  port?: number;
  dbPath?: string;
  cleanupIntervalMs?: number;
  /**
   * Override the liveness probe. Useful for tests where PIDs are fabricated.
   * Production uses `process.kill(pid, 0)` which raises on dead PIDs.
   */
  isPidAlive?: (pid: number) => boolean;
}

export interface Broker {
  start(): Promise<void>;
  stop(): Promise<void>;
  port(): number;
  _db(): DatabaseType;
}

export function createBroker(opts: BrokerOptions = {}): Broker {
  const dbPath = opts.dbPath ?? defaultDbPath();
  const cleanupIntervalMs = opts.cleanupIntervalMs ?? 30_000;
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;

  const db = new Database(dbPath);
  initSchema(db);

  const stmt = {
    insertPeer: db.prepare(`
      INSERT INTO peers (id, pid, cwd, git_root, tty, summary, auth_fingerprint, registered_at, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    deletePeerByPid: db.prepare("DELETE FROM peers WHERE pid = ?"),
    deletePeer: db.prepare("DELETE FROM peers WHERE id = ?"),
    updateLastSeen: db.prepare("UPDATE peers SET last_seen = ? WHERE id = ?"),
    updateSummary: db.prepare("UPDATE peers SET summary = ? WHERE id = ?"),
    selectPeerById: db.prepare("SELECT * FROM peers WHERE id = ?"),
    selectPeersByFingerprint: db.prepare(
      "SELECT * FROM peers WHERE auth_fingerprint = ?",
    ),
    selectPeersByFingerprintAndCwd: db.prepare(
      "SELECT * FROM peers WHERE auth_fingerprint = ? AND cwd = ?",
    ),
    selectPeersByFingerprintAndGitRoot: db.prepare(
      "SELECT * FROM peers WHERE auth_fingerprint = ? AND git_root = ?",
    ),
    insertMessage: db.prepare(`
      INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
      VALUES (?, ?, ?, ?, 0)
    `),
    selectUndelivered: db.prepare(
      "SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY id ASC",
    ),
    markDelivered: db.prepare("UPDATE messages SET delivered = 1 WHERE id = ?"),
    allPeers: db.prepare("SELECT id, pid FROM peers"),
    peerCount: db.prepare("SELECT COUNT(*) AS n FROM peers"),
  };

  function reapDeadPeers(): void {
    const rows = stmt.allPeers.all() as { id: string; pid: number }[];
    let removed = 0;
    for (const row of rows) {
      if (!isPidAlive(row.pid)) {
        stmt.deletePeer.run(row.id);
        removed++;
      }
    }
    if (removed > 0) log.debug({ removed }, "reaped dead peers");
  }

  function handleRegister(body: RegisterRequest): RegisterResponse {
    stmt.deletePeerByPid.run(body.pid);
    const id = generateId();
    const now = new Date().toISOString();
    stmt.insertPeer.run(
      id,
      body.pid,
      body.cwd,
      body.git_root,
      body.tty,
      body.summary,
      body.auth_fingerprint,
      now,
      now,
    );
    return { id };
  }

  function handleHeartbeat(body: HeartbeatRequest): { ok: boolean } {
    stmt.updateLastSeen.run(new Date().toISOString(), body.id);
    return { ok: true };
  }

  function handleSetSummary(body: SetSummaryRequest): { ok: boolean } {
    stmt.updateSummary.run(body.summary, body.id);
    return { ok: true };
  }

  function handleListPeers(body: ListPeersRequest): Peer[] {
    let rows: PeerRow[];
    if (body.scope === "directory") {
      rows = stmt.selectPeersByFingerprintAndCwd.all(
        body.auth_fingerprint,
        body.cwd,
      ) as PeerRow[];
    } else if (body.scope === "repo" && body.git_root) {
      rows = stmt.selectPeersByFingerprintAndGitRoot.all(
        body.auth_fingerprint,
        body.git_root,
      ) as PeerRow[];
    } else {
      rows = stmt.selectPeersByFingerprint.all(
        body.auth_fingerprint,
      ) as PeerRow[];
    }
    return rows
      .filter((r) => r.id !== body.caller_id)
      .filter((r) => {
        if (isPidAlive(r.pid)) return true;
        stmt.deletePeer.run(r.id);
        return false;
      })
      .map(toWirePeer);
  }

  function handleSendMessage(body: SendMessageRequest): SendMessageResponse {
    const from = stmt.selectPeerById.get(body.from_id) as PeerRow | undefined;
    const to = stmt.selectPeerById.get(body.to_id) as PeerRow | undefined;

    if (!from)
      return { ok: false, error: `sender ${body.from_id} not registered` };
    if (!to) return { ok: false, error: `recipient ${body.to_id} not found` };

    if (from.auth_fingerprint !== body.auth_fingerprint) {
      return { ok: false, error: "auth fingerprint mismatch" };
    }
    if (to.auth_fingerprint !== body.auth_fingerprint) {
      return { ok: false, error: "recipient not reachable" };
    }

    stmt.insertMessage.run(
      body.from_id,
      body.to_id,
      body.text,
      new Date().toISOString(),
    );
    return { ok: true };
  }

  function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
    const rows = stmt.selectUndelivered.all(body.id) as MessageRow[];
    const tx = db.transaction(() => {
      for (const row of rows) stmt.markDelivered.run(row.id);
    });
    tx();
    return { messages: rows.map(toWireMessage) };
  }

  function handleUnregister(body: UnregisterRequest): { ok: boolean } {
    stmt.deletePeer.run(body.id);
    return { ok: true };
  }

  function handleHealth(): HealthResponse {
    const row = stmt.peerCount.get() as { n: number };
    return { status: "ok", peers: row.n, version: BROKER_VERSION };
  }

  async function readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return {};
    return JSON.parse(raw);
  }

  function json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload).toString(),
    });
    res.end(payload);
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        return json(res, 200, handleHealth());
      }
      if (req.method !== "POST") {
        return json(res, 405, { error: "method not allowed" });
      }
      const body = await readJson(req);
      switch (req.url) {
        case "/register":
          return json(res, 200, handleRegister(body as RegisterRequest));
        case "/heartbeat":
          return json(res, 200, handleHeartbeat(body as HeartbeatRequest));
        case "/set-summary":
          return json(res, 200, handleSetSummary(body as SetSummaryRequest));
        case "/list-peers":
          return json(res, 200, handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return json(res, 200, handleSendMessage(body as SendMessageRequest));
        case "/poll-messages":
          return json(
            res,
            200,
            handlePollMessages(body as PollMessagesRequest),
          );
        case "/unregister":
          return json(res, 200, handleUnregister(body as UnregisterRequest));
        default:
          return json(res, 404, { error: "not found" });
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "broker handler error",
      );
      json(res, 500, {
        error: err instanceof Error ? err.message : "internal error",
      });
    }
  });

  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  return {
    async start(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(opts.port ?? DEFAULT_BROKER_PORT, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      reapDeadPeers();
      if (cleanupIntervalMs > 0) {
        cleanupTimer = setInterval(reapDeadPeers, cleanupIntervalMs);
        if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();
      }
    },
    async stop(): Promise<void> {
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      db.close();
    },
    port(): number {
      const addr = server.address();
      if (addr && typeof addr === "object") return addr.port;
      return opts.port ?? DEFAULT_BROKER_PORT;
    },
    _db(): DatabaseType {
      return db;
    },
  };
}

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultDbPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return `${home}/.brainstorm/broker.db`;
}
