// @brainst0rm/endpoint-stub — reference implementation of the endpoint
// side of the Brainstorm dispatch protocol.
//
// Roles served:
//   1. Test fixture for distributed dispatch flows (Stage 1.1+)
//   2. Reference for crd4sdom's production brainstorm-agent (Go)
//      — semantics of CommandAck timing, signature verification, lifecycle
//   3. Self-contained dev endpoint for `brainstorm dispatch` smoke tests
//
// What it does:
//   - Generates an Ed25519 keypair on first run (persists to disk)
//   - Enrolls via /v1/endpoint/enroll using a bootstrap token (CLI arg or env)
//   - Connects to /v1/endpoint/connect with a signed connection_proof
//   - Receives CommandEnvelopes; verifies signature + audience + nonce
//   - Dispatches to a pluggable executor (default: stub echoing the params)
//   - Emits CommandAck immediately, then CommandResult
//
// What it does NOT do (out of scope; production brainstorm-agent's job):
//   - microVM sandbox isolation (P3 work)
//   - Real evidence-chain hashing of execution
//   - Reset machinery
//   - GuestQuery / GuestResponse handling
//
// The stub is honest about being a stub — every result includes
// `{ stub: true }` in payload metadata so consumers can see they're
// not running against a real isolated endpoint.

import { randomUUID, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import WebSocket from "ws";
import * as ed25519 from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { signingInput, SIGN_CONTEXT, verifyEnvelope } from "@brainst0rm/relay";
import type {
  CommandEnvelope,
  CompletedCommandResult,
  FailedCommandResult,
  EndpointHello,
} from "@brainst0rm/relay";

// ---------------------------------------------------------------------------

export interface ToolExecutorContext {
  command_id: string;
  tool: string;
  params: Record<string, unknown>;
  /** Caller-supplied deadline for the tool. Tools that exceed should fail. */
  deadline_ms: number;
}

export interface ToolExecutorResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

export type ToolExecutor = (
  ctx: ToolExecutorContext,
) => Promise<ToolExecutorResult>;

/**
 * Default executor: echoes params back. Marks `stub: true` in stdout JSON
 * so consumers can identify they're hitting a stub, not a sandboxed tool.
 */
export const stubExecutor: ToolExecutor = async (ctx) => {
  const stdout = JSON.stringify(
    {
      stub: true,
      tool: ctx.tool,
      params: ctx.params,
      command_id: ctx.command_id,
    },
    null,
    2,
  );
  return { exit_code: 0, stdout: stdout + "\n", stderr: "" };
};

// ---------------------------------------------------------------------------

export interface EndpointStubOptions {
  /** Relay base URL, e.g. "ws://127.0.0.1:8443" */
  relayUrl: string;
  /** Tenant id (must match relay config). */
  tenantId: string;
  /** Persistent keypair + endpoint_id storage path. Auto-created. */
  identityPath: string;
  /** Endpoint-id (UUID) — must match the bootstrap token's endpoint_id. */
  endpointId: string;
  /** Tenant public key for verifying CommandEnvelope signatures (Ed25519). */
  tenantPublicKey: Uint8Array;
  /** Tool executor. Defaults to stubExecutor (echo-style). */
  executor?: ToolExecutor;
  /** Logger. Defaults to console. */
  logger?: { info: (msg: string) => void; error: (msg: string) => void };
}

interface PersistedIdentity {
  endpoint_id: string;
  private_key_hex: string;
}

export class EndpointStub {
  private readonly opts: EndpointStubOptions;
  private readonly executor: ToolExecutor;
  private readonly log: {
    info: (m: string) => void;
    error: (m: string) => void;
  };
  private readonly identity: PersistedIdentity;
  private ws: WebSocket | null = null;
  private session_id: string | null = null;
  private readonly seenNonces = new Set<string>();
  private closeResolver: (() => void) | null = null;

  constructor(opts: EndpointStubOptions) {
    this.opts = opts;
    this.executor = opts.executor ?? stubExecutor;
    this.log = opts.logger ?? {
      info: (m) => console.log(`[endpoint-stub] ${m}`),
      error: (m) => console.error(`[endpoint-stub] ${m}`),
    };
    this.identity = loadOrCreateIdentity(opts.identityPath, opts.endpointId);
  }

  /**
   * Public key derived from the persisted private key. Caller can fetch
   * this and register it via `/v1/endpoint/enroll`.
   */
  async publicKeyB64(): Promise<string> {
    const priv = hexToBytes(this.identity.private_key_hex);
    const pub = await ed25519.getPublicKeyAsync(priv);
    return bytesToBase64(pub);
  }

  /**
   * Open the WebSocket, install the dispatch listener, send EndpointHello,
   * await EndpointHelloAck. After this resolves the stub has a `session_id`
   * and the relay can route CommandEnvelopes to us — and any envelope that
   * arrives after this returns is handled by the same listener that was
   * present throughout the handshake (no listener-handoff race).
   */
  async connect(): Promise<void> {
    if (this.ws !== null && this.session_id !== null) return;

    const url = this.opts.relayUrl + "/v1/endpoint/connect";
    this.log.info(`connecting to ${url}`);
    const ws = new WebSocket(url);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    // Install the persistent message listener BEFORE sending EndpointHello.
    // It serves both the handshake (signals once EndpointHelloAck arrives)
    // and the dispatch loop (routes CommandEnvelope, HealthPing). No
    // off()/on() handoff means no frame-drop window.
    ws.on("message", (data: WebSocket.RawData): void => {
      const text =
        data instanceof Buffer ? data.toString("utf-8") : String(data);
      let frame: { type: string; [k: string]: unknown };
      try {
        frame = JSON.parse(text) as { type: string; [k: string]: unknown };
      } catch {
        this.log.error("could not parse JSON frame");
        return;
      }
      // Don't await here — handlers run concurrently. handleCommandEnvelope
      // is responsible for serialization-where-needed via its own internal
      // state. (For the stub this is fine: no shared mutable state across
      // commands beyond the nonce set, which is non-blocking.)
      void this.routeFrame(frame);
    });
    ws.once("close", () => {
      if (this.closeResolver !== null) this.closeResolver();
    });
    ws.once("error", (err) => {
      this.log.error(`ws error: ${err.message}`);
      if (this.closeResolver !== null) this.closeResolver();
    });

    // Send EndpointHello with signed connection_proof
    const ts = new Date().toISOString();
    const proofPayload = {
      endpoint_id: this.identity.endpoint_id,
      tenant_id: this.opts.tenantId,
      ts,
    };
    const proofInput = signingInput(
      SIGN_CONTEXT.CONNECTION_PROOF,
      proofPayload,
    );
    const proofDigest = sha256(proofInput);
    const privBytes = hexToBytes(this.identity.private_key_hex);
    const proofSig = await ed25519.signAsync(proofDigest, privBytes);

    const hello: EndpointHello = {
      type: "EndpointHello",
      endpoint_id: this.identity.endpoint_id,
      tenant_id: this.opts.tenantId,
      agent_version: "endpoint-stub-0.1.0",
      agent_protocol_version: "v1",
      connection_proof: { ts, signature: bytesToBase64(proofSig) },
    };
    await this.send(hello);

    // Wait for the listener above to see EndpointHelloAck and set session_id.
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const tick = (): void => {
        if (this.session_id !== null) {
          resolve();
          return;
        }
        if (Date.now() - start > 10_000) {
          reject(new Error("timed out waiting for EndpointHelloAck"));
          return;
        }
        setTimeout(tick, 5);
      };
      tick();
    });
  }

  /**
   * Block until the WebSocket closes. Calls connect() if not already
   * connected. Frames arriving in between are handled by the listener
   * installed by connect().
   */
  async run(): Promise<void> {
    await this.connect();
    await new Promise<void>((resolve) => {
      this.closeResolver = resolve;
    });
  }

  private async routeFrame(frame: {
    type: string;
    [k: string]: unknown;
  }): Promise<void> {
    if (frame.type === "EndpointHelloAck") {
      this.session_id = String(frame.session_id);
      this.log.info(`session established: ${this.session_id}`);
    } else if (frame.type === "CommandEnvelope") {
      await this.handleCommandEnvelope(frame as unknown as CommandEnvelope);
    } else if (frame.type === "HealthPing") {
      await this.send({
        type: "HealthPong",
        session_id: this.session_id,
        ts: new Date().toISOString(),
        ping_id: String((frame as { ping_id?: string }).ping_id ?? ""),
        agent_health: "ok",
      });
    }
  }

  async close(): Promise<void> {
    if (this.ws !== null) {
      try {
        this.ws.close(1000, "stub shutdown");
      } catch {}
      this.ws = null;
    }
  }

  // --- internals ----------------------------------------------------------

  private async handleCommandEnvelope(
    envelope: CommandEnvelope,
  ): Promise<void> {
    const command_id = envelope.command_id;

    // 1. Signature (Ed25519 over JCS) — must come first so we can trust
    //    the rest of the fields below.
    const verifyOk = await verifyEnvelope(
      SIGN_CONTEXT.COMMAND_ENVELOPE,
      envelope as unknown as Record<string, unknown> & {
        signature: string;
        signature_algo?: "ed25519-jcs-sha256-v1";
      },
      this.opts.tenantPublicKey,
    );
    if (!verifyOk) {
      this.log.error(
        `CommandEnvelope ${command_id} signature verification FAILED`,
      );
      await this.sendError(
        command_id,
        "ENDPOINT_SIGNATURE_INVALID",
        "Ed25519 signature failed verification",
      );
      return;
    }

    // 2. Audience: target_endpoint_id binding (F5 — cross-endpoint replay).
    if (envelope.target_endpoint_id !== this.identity.endpoint_id) {
      this.log.error(
        `CommandEnvelope ${command_id} target_endpoint_id mismatch (expected ${this.identity.endpoint_id}, got ${envelope.target_endpoint_id})`,
      );
      await this.sendError(
        command_id,
        "ENDPOINT_WRONG_AUDIENCE",
        "target_endpoint_id does not match this endpoint",
      );
      return;
    }

    // 3. Tenant binding — same defense, second axis.
    if (envelope.tenant_id !== this.opts.tenantId) {
      await this.sendError(
        command_id,
        "ENDPOINT_WRONG_AUDIENCE",
        `tenant_id ${envelope.tenant_id} does not match this endpoint's tenant ${this.opts.tenantId}`,
      );
      return;
    }

    // 4. Session epoch (F12 — relay-restart stale session). The relay
    //    addresses commands to the current connection's session_id; an
    //    envelope with a different epoch is from a prior connection and
    //    must not be executed.
    if (envelope.session_id !== this.session_id) {
      await this.sendError(
        command_id,
        "ENDPOINT_SESSION_STALE",
        `envelope session_id ${envelope.session_id} does not match current session ${this.session_id}`,
      );
      return;
    }

    // 5. Time skew + freshness. Spec §5.3:
    //    - issued_at must be within ±60s of now (clock-skew tolerance)
    //    - expires_at must not be in the past
    //    - max envelope lifetime: 5 minutes (issued_at + 300s ≥ expires_at)
    const now = new Date();
    const issuedAt = new Date(envelope.issued_at);
    const expiresAt = new Date(envelope.expires_at);
    if (Number.isNaN(issuedAt.getTime()) || Number.isNaN(expiresAt.getTime())) {
      await this.sendError(
        command_id,
        "ENDPOINT_ENVELOPE_EXPIRED",
        "issued_at or expires_at is not a valid ISO-8601 timestamp",
      );
      return;
    }
    const skewMs = Math.abs(issuedAt.getTime() - now.getTime());
    if (skewMs > 60_000) {
      await this.sendError(
        command_id,
        "ENDPOINT_ENVELOPE_EXPIRED",
        `issued_at ${envelope.issued_at} is more than 60s from endpoint clock`,
      );
      return;
    }
    if (expiresAt <= now) {
      await this.sendError(
        command_id,
        "ENDPOINT_ENVELOPE_EXPIRED",
        `expires_at ${envelope.expires_at} is in the past`,
      );
      return;
    }
    const lifetimeMs = expiresAt.getTime() - issuedAt.getTime();
    if (lifetimeMs > 5 * 60 * 1000) {
      await this.sendError(
        command_id,
        "ENDPOINT_ENVELOPE_EXPIRED",
        `envelope lifetime ${lifetimeMs}ms exceeds protocol max of 300000ms`,
      );
      return;
    }

    // 6. Nonce uniqueness — replay defense (F8). Persistent nonce store is
    //    the production agent's job; the stub keeps an in-memory set so
    //    intra-process replays are caught.
    if (this.seenNonces.has(envelope.nonce)) {
      await this.sendError(
        command_id,
        "ENDPOINT_NONCE_REPLAY",
        `nonce ${envelope.nonce} has been seen before`,
      );
      return;
    }
    this.seenNonces.add(envelope.nonce);

    // Send CommandAck
    await this.send({
      type: "CommandAck",
      command_id,
      endpoint_id: this.identity.endpoint_id,
      session_id: this.session_id,
      track: "data_provider", // stub: treat all as read-only
      will_emit_progress: false,
      ts: new Date().toISOString(),
    });

    // Execute
    let executorResult: ToolExecutorResult;
    try {
      executorResult = await this.executor({
        command_id,
        tool: envelope.tool,
        params: envelope.params,
        deadline_ms: 30_000,
      });
    } catch (e) {
      const failed: FailedCommandResult = {
        type: "CommandResult",
        command_id,
        endpoint_id: this.identity.endpoint_id,
        session_id: this.session_id!,
        lifecycle_state: "failed",
        payload: null,
        error: {
          code: "SANDBOX_TOOL_ERROR",
          message: (e as Error).message,
        },
        evidence_hash: stubEvidenceHash(command_id),
        ts: new Date().toISOString(),
      };
      await this.send(failed);
      return;
    }

    // Send CommandResult
    if (executorResult.exit_code === 0) {
      const completed: CompletedCommandResult = {
        type: "CommandResult",
        command_id,
        endpoint_id: this.identity.endpoint_id,
        session_id: this.session_id!,
        lifecycle_state: "completed",
        error: null,
        payload: {
          stdout: executorResult.stdout,
          stderr: executorResult.stderr,
          exit_code: 0,
        },
        evidence_hash: stubEvidenceHash(command_id),
        sandbox_reset_state: stubResetState(),
        ts: new Date().toISOString(),
      };
      await this.send(completed);
    } else {
      const failed: FailedCommandResult = {
        type: "CommandResult",
        command_id,
        endpoint_id: this.identity.endpoint_id,
        session_id: this.session_id!,
        lifecycle_state: "failed",
        payload: null,
        error: {
          code: "SANDBOX_TOOL_ERROR",
          message: `tool exited with ${executorResult.exit_code}: ${executorResult.stderr}`,
        },
        evidence_hash: stubEvidenceHash(command_id),
        ts: new Date().toISOString(),
      };
      await this.send(failed);
    }
  }

  private send(frame: object): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws === null) {
        reject(new Error("not connected"));
        return;
      }
      this.ws.send(JSON.stringify(frame), (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  private sendError(
    command_id: string,
    code: string,
    message: string,
  ): Promise<void> {
    return this.send({
      type: "ErrorEvent",
      command_id,
      endpoint_id: this.identity.endpoint_id,
      session_id: this.session_id,
      code,
      message,
      ts: new Date().toISOString(),
    });
  }
}

// ---------------------------------------------------------------------------

function loadOrCreateIdentity(
  path: string,
  endpoint_id: string,
): PersistedIdentity {
  if (existsSync(path)) {
    const text = readFileSync(path, "utf-8");
    const parsed = JSON.parse(text) as PersistedIdentity;
    if (parsed.endpoint_id !== endpoint_id) {
      throw new Error(
        `identity file at ${path} has endpoint_id=${parsed.endpoint_id}; expected ${endpoint_id}`,
      );
    }
    return parsed;
  }
  // Create fresh keypair
  const priv = ed25519.utils.randomPrivateKey();
  const id: PersistedIdentity = {
    endpoint_id,
    private_key_hex: bytesToHex(priv),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(id, null, 2), { mode: 0o600 });
  return id;
}

function stubEvidenceHash(command_id: string): string {
  // Deterministic stub-hash so audit chains are still meaningfully scoped.
  const h = sha256(new TextEncoder().encode("stub-evidence:" + command_id));
  return "sha256:" + bytesToHex(h);
}

function stubResetState() {
  const ts = new Date().toISOString();
  return {
    reset_at: ts,
    golden_hash: "sha256:" + "0".repeat(64),
    verification_passed: true,
    verification_details: {
      fs_hash: "sha256:" + "0".repeat(64),
      fs_hash_baseline: "sha256:" + "0".repeat(64),
      fs_hash_match: true,
      open_fd_count: 3,
      open_fd_count_baseline: 3,
      vmm_api_state: "running" as const,
      expected_vmm_api_state: "running" as const,
      divergence_action: "none" as const,
    },
  };
}

function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return Buffer.from(s, "binary").toString("base64");
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.replace(/\s+/g, "").toLowerCase();
  if (!/^[0-9a-f]*$/.test(cleaned) || cleaned.length % 2 !== 0) {
    throw new Error("invalid hex");
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    out[i / 2] = parseInt(cleaned.slice(i, i + 2), 16);
  }
  return out;
}
