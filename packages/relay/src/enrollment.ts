// Endpoint enrollment HTTP endpoints per protocol-v1 §3.1.
//
//   POST /v1/admin/endpoint/enroll
//     - Admin auth (Bearer token from env or config)
//     - Body: { tenant_id, endpoint_id_hint? }
//     - Returns: { bootstrap_token, tenant_id, endpoint_id, expires_at }
//
//   POST /v1/endpoint/enroll
//     - Authorization: Bearer <bootstrap_token>
//     - Body: { public_key, os, arch, agent_version }
//     - Atomic token consumption (single-use within 24h TTL)
//     - Stores endpoint pubkey in registry
//     - Returns: { endpoint_id, registered_at }
//
//   POST /v1/admin/endpoint/<endpoint_id>/rotate
//     - Admin auth
//     - Marks current pubkey revoked, issues fresh bootstrap_token
//
// Storage: SQLite endpoint registry. Bootstrap tokens are also persisted
// in their own table with status flag for atomic consumption.

import Database from "better-sqlite3";
import { randomUUID, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";

const REGISTRY_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS endpoints (
    endpoint_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    public_key_b64 TEXT,
    os TEXT,
    arch TEXT,
    agent_version TEXT,
    enrolled_at TEXT,
    revoked INTEGER NOT NULL DEFAULT 0,
    revoked_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS bootstrap_tokens (
    token TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    endpoint_id TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('issued', 'consumed', 'expired')),
    consumed_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bootstrap_endpoint ON bootstrap_tokens(endpoint_id)`,
];

const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------

export interface EndpointRegistryOptions {
  dbPath: string;
}

export class EndpointRegistry {
  private readonly db: Database.Database;
  private readonly issueTokenStmt: Database.Statement;
  private readonly consumeTokenStmt: Database.Statement;
  private readonly getTokenStmt: Database.Statement;
  private readonly insertEndpointStmt: Database.Statement;
  private readonly updateEndpointKeyStmt: Database.Statement;
  private readonly getEndpointStmt: Database.Statement;
  private readonly revokeEndpointStmt: Database.Statement;

  constructor(opts: EndpointRegistryOptions) {
    this.db = new Database(opts.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    for (const s of REGISTRY_SCHEMA_STATEMENTS) {
      this.db.prepare(s).run();
    }
    this.issueTokenStmt = this.db.prepare(
      `INSERT INTO bootstrap_tokens (token, tenant_id, endpoint_id, issued_at, expires_at, status) VALUES (?, ?, ?, ?, ?, 'issued')`,
    );
    this.consumeTokenStmt = this.db.prepare(
      `UPDATE bootstrap_tokens SET status = 'consumed', consumed_at = ? WHERE token = ? AND status = 'issued' AND expires_at > ?`,
    );
    this.getTokenStmt = this.db.prepare(
      `SELECT token, tenant_id, endpoint_id, issued_at, expires_at, status FROM bootstrap_tokens WHERE token = ?`,
    );
    this.insertEndpointStmt = this.db.prepare(
      `INSERT INTO endpoints (endpoint_id, tenant_id, public_key_b64, os, arch, agent_version, enrolled_at, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, 0) ON CONFLICT(endpoint_id) DO UPDATE SET public_key_b64 = excluded.public_key_b64, os = excluded.os, arch = excluded.arch, agent_version = excluded.agent_version, enrolled_at = excluded.enrolled_at, revoked = 0`,
    );
    this.updateEndpointKeyStmt = this.db.prepare(
      `UPDATE endpoints SET public_key_b64 = ?, os = ?, arch = ?, agent_version = ?, enrolled_at = ?, revoked = 0 WHERE endpoint_id = ?`,
    );
    this.getEndpointStmt = this.db.prepare(
      `SELECT endpoint_id, tenant_id, public_key_b64, os, arch, agent_version, enrolled_at, revoked FROM endpoints WHERE endpoint_id = ?`,
    );
    this.revokeEndpointStmt = this.db.prepare(
      `UPDATE endpoints SET revoked = 1, revoked_at = ? WHERE endpoint_id = ?`,
    );
  }

  /**
   * Issue a fresh bootstrap_token. tenant_id required; endpoint_id is
   * either provided (re-enrollment) or generated fresh.
   */
  issueToken(args: { tenant_id: string; endpoint_id?: string }): {
    bootstrap_token: string;
    tenant_id: string;
    endpoint_id: string;
    expires_at: string;
  } {
    const token = randomBytes(32).toString("base64url");
    const endpoint_id = args.endpoint_id ?? randomUUID();
    const issued_at = new Date();
    const expires_at = new Date(issued_at.getTime() + BOOTSTRAP_TTL_MS);
    this.issueTokenStmt.run(
      token,
      args.tenant_id,
      endpoint_id,
      issued_at.toISOString(),
      expires_at.toISOString(),
    );
    // Also pre-create the endpoint row so the foreign-key-shape is intact
    // on enroll. Public key remains null until /v1/endpoint/enroll lands.
    const existing = this.getEndpointStmt.get(endpoint_id);
    if (existing === undefined) {
      this.insertEndpointStmt.run(
        endpoint_id,
        args.tenant_id,
        null,
        null,
        null,
        null,
        null,
      );
    }
    return {
      bootstrap_token: token,
      tenant_id: args.tenant_id,
      endpoint_id,
      expires_at: expires_at.toISOString(),
    };
  }

  /**
   * Consume a bootstrap token + register the endpoint's public key.
   * Atomic: either the token is consumed and the endpoint registered,
   * or the operation fails (token already consumed, expired, missing).
   */
  enrollEndpoint(args: {
    bootstrap_token: string;
    public_key_b64: string;
    os: string;
    arch: string;
    agent_version: string;
  }):
    | { ok: true; endpoint_id: string; tenant_id: string; enrolled_at: string }
    | {
        ok: false;
        code: "TOKEN_NOT_FOUND" | "TOKEN_ALREADY_CONSUMED" | "TOKEN_EXPIRED";
      } {
    const tokenRow = this.getTokenStmt.get(args.bootstrap_token) as
      | {
          token: string;
          tenant_id: string;
          endpoint_id: string;
          expires_at: string;
          status: string;
        }
      | undefined;
    if (tokenRow === undefined) {
      return { ok: false, code: "TOKEN_NOT_FOUND" };
    }
    if (tokenRow.status === "consumed") {
      return { ok: false, code: "TOKEN_ALREADY_CONSUMED" };
    }
    if (new Date(tokenRow.expires_at) < new Date()) {
      return { ok: false, code: "TOKEN_EXPIRED" };
    }
    const now = new Date().toISOString();
    const txn = this.db.transaction(() => {
      const consumeResult = this.consumeTokenStmt.run(
        now,
        args.bootstrap_token,
        now,
      );
      if (consumeResult.changes === 0) {
        return { ok: false as const, code: "TOKEN_ALREADY_CONSUMED" as const };
      }
      this.updateEndpointKeyStmt.run(
        args.public_key_b64,
        args.os,
        args.arch,
        args.agent_version,
        now,
        tokenRow.endpoint_id,
      );
      return {
        ok: true as const,
        endpoint_id: tokenRow.endpoint_id,
        tenant_id: tokenRow.tenant_id,
        enrolled_at: now,
      };
    });
    return txn();
  }

  /**
   * Look up an endpoint's public key. Returns the raw bytes, or null if
   * unknown / revoked.
   */
  getPublicKey(endpoint_id: string): Uint8Array | null {
    const row = this.getEndpointStmt.get(endpoint_id) as
      | { public_key_b64: string | null; revoked: number }
      | undefined;
    if (row === undefined || row.public_key_b64 === null || row.revoked === 1) {
      return null;
    }
    const bin = atob(row.public_key_b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /**
   * Revoke an endpoint's current key. Used during key-rotation flow.
   */
  revokeEndpoint(endpoint_id: string): boolean {
    const now = new Date().toISOString();
    const result = this.revokeEndpointStmt.run(now, endpoint_id);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------

export interface EnrollmentHttpOptions {
  port: number;
  host?: string;
  registry: EndpointRegistry;
  /** Static admin token for /v1/admin/* endpoints. Bootstrapped from env. */
  adminToken: string;
}

export interface EnrollmentHttpHandle {
  close(): Promise<void>;
  port(): number;
}

export function startEnrollmentHttp(
  opts: EnrollmentHttpOptions,
): Promise<EnrollmentHttpHandle> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer(async (req, res) => {
      try {
        await handleRequest({ req, res, opts });
      } catch (e) {
        sendJson(res, 500, {
          code: "INTERNAL_ERROR",
          message: (e as Error).message,
        });
      }
    });
    server.on("error", reject);
    server.listen(opts.port, opts.host ?? "127.0.0.1", () => {
      const addr = server.address();
      const actualPort =
        typeof addr === "object" && addr !== null && "port" in addr
          ? (addr as { port: number }).port
          : opts.port;
      resolve({
        async close() {
          await new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          });
        },
        port() {
          return actualPort;
        },
      });
    });
  });
}

async function handleRequest(args: {
  req: IncomingMessage;
  res: ServerResponse;
  opts: EnrollmentHttpOptions;
}): Promise<void> {
  const { req, res, opts } = args;
  const url = req.url ?? "";

  if (req.method !== "POST") {
    sendJson(res, 405, { code: "METHOD_NOT_ALLOWED" });
    return;
  }

  const body = await readBody(req);
  let parsedBody: Record<string, unknown>;
  try {
    parsedBody = JSON.parse(body) as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { code: "INVALID_JSON" });
    return;
  }

  if (url === "/v1/admin/endpoint/enroll") {
    if (!checkAdminAuth(req, opts.adminToken)) {
      sendJson(res, 401, { code: "AUTH_INVALID_PROOF" });
      return;
    }
    const tenant_id = parsedBody.tenant_id as string | undefined;
    if (typeof tenant_id !== "string") {
      sendJson(res, 400, { code: "INVALID_TENANT_ID" });
      return;
    }
    const result = opts.registry.issueToken({
      tenant_id,
      endpoint_id: parsedBody.endpoint_id as string | undefined,
    });
    sendJson(res, 200, result);
    return;
  }

  if (url === "/v1/endpoint/enroll") {
    const auth = req.headers.authorization;
    if (typeof auth !== "string" || !auth.startsWith("Bearer ")) {
      sendJson(res, 401, { code: "AUTH_INVALID_PROOF" });
      return;
    }
    const token = auth.slice("Bearer ".length);
    const public_key_b64 = parsedBody.public_key as string | undefined;
    if (typeof public_key_b64 !== "string") {
      sendJson(res, 400, { code: "INVALID_PUBLIC_KEY" });
      return;
    }
    const result = opts.registry.enrollEndpoint({
      bootstrap_token: token,
      public_key_b64,
      os: (parsedBody.os as string | undefined) ?? "unknown",
      arch: (parsedBody.arch as string | undefined) ?? "unknown",
      agent_version:
        (parsedBody.agent_version as string | undefined) ?? "unknown",
    });
    if (result.ok) {
      sendJson(res, 200, {
        endpoint_id: result.endpoint_id,
        tenant_id: result.tenant_id,
        registered_at: result.enrolled_at,
      });
    } else {
      const status = result.code === "TOKEN_NOT_FOUND" ? 404 : 409;
      sendJson(res, status, { code: result.code });
    }
    return;
  }

  // /v1/admin/endpoint/<id>/rotate
  const rotateMatch = url.match(/^\/v1\/admin\/endpoint\/([^/]+)\/rotate$/);
  if (rotateMatch) {
    if (!checkAdminAuth(req, opts.adminToken)) {
      sendJson(res, 401, { code: "AUTH_INVALID_PROOF" });
      return;
    }
    const endpoint_id = decodeURIComponent(rotateMatch[1]);
    opts.registry.revokeEndpoint(endpoint_id);
    const tenant_id = parsedBody.tenant_id as string | undefined;
    if (typeof tenant_id !== "string") {
      sendJson(res, 400, { code: "INVALID_TENANT_ID" });
      return;
    }
    const result = opts.registry.issueToken({ tenant_id, endpoint_id });
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { code: "NOT_FOUND" });
}

function checkAdminAuth(req: IncomingMessage, adminToken: string): boolean {
  const auth = req.headers.authorization;
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) return false;
  const provided = auth.slice("Bearer ".length);
  // Constant-time comparison
  if (provided.length !== adminToken.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ adminToken.charCodeAt(i);
  }
  return diff === 0;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function sendJson(res: ServerResponse, status: number, body: object): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}
