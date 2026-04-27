// Dispatch orchestration per protocol-v1 §4-5.
//
// One `Dispatch` instance handles a single dispatch from operator's
// DispatchRequest → ChangeSetPreview → ConfirmRequest → CommandEnvelope to
// endpoint → CommandAck → ProgressEvents → CommandResult → ResultEvent
// back to operator.
//
// Async flow with deadlines:
//   - T_ack_timeout = 5s after relay's successful WS-write of CommandEnvelope
//     (per V3-ACK-01 fix: relay-observable, not endpoint-receipt)
//   - operator deadline_ms is the overall dispatch timeout
//   - ACK timeout from `dispatched` → `timed_out` with ENDPOINT_NO_ACK

import { randomUUID, randomBytes } from "node:crypto";

import type {
  DispatchRequest,
  ChangeSetPreview,
  ConfirmRequest,
  CommandEnvelope,
  CommandAck,
  CommandResult,
  ProgressEventEndpointSide,
  ResultEvent,
  ErrorEventRelayToOperator,
  Operator,
} from "./types.js";
import {
  signEnvelope,
  verifyEnvelope,
  type SignableEnvelope,
} from "./signing.js";
import { SIGN_CONTEXT, canonicalBytes } from "./canonical.js";
import type { AuditLog } from "./audit.js";
import type { NonceStore } from "./nonce-store.js";
import type { SessionStore } from "./session-store.js";
import { LifecycleManager } from "./lifecycle.js";
import { sha256 } from "@noble/hashes/sha256";

const T_ACK_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------

export interface TenantSigningContext {
  signing_key_id: string;
  /** 32-byte Ed25519 private key seed */
  private_key: Uint8Array;
}

export interface DispatchOrchestratorOptions {
  audit: AuditLog;
  nonces: NonceStore;
  sessions: SessionStore;
  lifecycle: LifecycleManager;
  /**
   * Per-tenant signing context. Looked up by tenant_id. The relay must hold
   * each tenant's signing key (not derivable from operator/endpoint keys).
   */
  tenantSigning: (tenant_id: string) => TenantSigningContext | null;
  /**
   * Per-endpoint Ed25519 public key lookup for verifying endpoint-side
   * signatures (e.g. EndpointHello connection_proof). Returns null on
   * unknown endpoint.
   */
  endpointPublicKey: (endpoint_id: string) => Uint8Array | null;
  /**
   * Now provider for testability. Defaults to () => new Date().
   */
  now?: () => Date;
}

export interface OperatorDispatchContext {
  operator_session_id: string;
  operator: Operator;
  tenant_id: string;
  /** Verbatim bytes received off the operator WS. Used for audit-log
   *  channel='operator' verbatim storage to preserve anti-contamination. */
  request_bytes: Uint8Array;
  /** The parsed DispatchRequest (the bytes above interpreted). */
  request: DispatchRequest;
}

// ---------------------------------------------------------------------------

export class DispatchOrchestrator {
  private readonly opts: DispatchOrchestratorOptions;
  private readonly now: () => Date;

  constructor(opts: DispatchOrchestratorOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Step 1: receive a DispatchRequest, validate, mint command_id, audit
   * the operator-origin payload verbatim, and emit a ChangeSetPreview.
   *
   * Returns the ChangeSetPreview frame the caller should send back to
   * the operator over their WS, plus the command_id (for tracking).
   */
  async beginDispatch(
    ctx: OperatorDispatchContext,
  ): Promise<
    | { ok: true; command_id: string; preview: ChangeSetPreview }
    | { ok: false; error: ErrorEventRelayToOperator }
  > {
    // Tenant consistency check — operator's tenant_id must match dispatch's
    if (ctx.request.tenant_id !== ctx.tenant_id) {
      return {
        ok: false,
        error: this.makeError(
          ctx.request.request_id,
          null,
          "AUTH_TENANT_MISMATCH",
          "DispatchRequest.tenant_id does not match operator session tenant_id",
        ),
      };
    }

    // Tenant signing context must exist (else relay can't sign envelopes)
    const tenantCtx = this.opts.tenantSigning(ctx.request.tenant_id);
    if (tenantCtx === null) {
      return {
        ok: false,
        error: this.makeError(
          ctx.request.request_id,
          null,
          "RELAY_INTERNAL_ERROR",
          "No signing context for tenant; relay misconfigured",
        ),
      };
    }

    // Endpoint must be registered AND have an active session
    const endpointSession = this.opts.sessions.getActiveEndpointSession(
      ctx.request.target_endpoint_id,
    );
    if (endpointSession === undefined) {
      return {
        ok: false,
        error: this.makeError(
          ctx.request.request_id,
          null,
          "RELAY_ENDPOINT_UNREACHABLE",
          `target_endpoint_id ${ctx.request.target_endpoint_id} has no active session`,
        ),
      };
    }
    if (endpointSession.tenant_id !== ctx.request.tenant_id) {
      return {
        ok: false,
        error: this.makeError(
          ctx.request.request_id,
          null,
          "AUTH_TENANT_MISMATCH",
          "endpoint tenant does not match dispatch tenant",
        ),
      };
    }

    // Mint command_id
    const command_id = randomUUID();

    // Reserve lifecycle (pending state)
    const reserveResult = this.opts.lifecycle.reserve(command_id);
    if (!reserveResult.ok) {
      // Should never happen — UUID collision
      return {
        ok: false,
        error: this.makeError(
          ctx.request.request_id,
          null,
          "RELAY_INTERNAL_ERROR",
          "command_id collision; this is a relay bug",
        ),
      };
    }

    // Audit: operator-origin entry (verbatim bytes preserved)
    this.opts.audit.append({
      command_id,
      ts: this.now().toISOString(),
      channel_of_origin: "operator",
      message_type: "DispatchRequest",
      payload_bytes: ctx.request_bytes, // verbatim, not re-canonicalized
      metadata_sidecar: {
        operator_session_id: ctx.operator_session_id,
        operator_kind: ctx.operator.kind,
        operator_id: ctx.operator.id,
      },
    });

    // Build ChangeSetPreview
    const preview_summary = this.buildPreviewSummary(ctx.request);
    const preview_hash = computePreviewHash(ctx.request, preview_summary);
    const preview: ChangeSetPreview = {
      type: "ChangeSetPreview",
      request_id: ctx.request.request_id,
      command_id,
      preview_summary,
      preview_hash,
      blast_radius: "low", // generic for MVP per D20
      reversibility: "moderate",
    };

    // Audit: relay-internal preview emission
    this.opts.audit.appendCanonical({
      command_id,
      ts: this.now().toISOString(),
      channel_of_origin: "relay-internal",
      message_type: "ChangeSetPreview",
      payload: preview,
      metadata_sidecar: {
        operator_session_id: ctx.operator_session_id,
      },
    });

    return { ok: true, command_id, preview };
  }

  /**
   * Step 2: receive ConfirmRequest, validate preview_hash, and produce
   * the signed CommandEnvelope. Caller is responsible for sending the
   * envelope to the endpoint and starting the T_ack_timeout timer.
   */
  async produceEnvelope(args: {
    request: DispatchRequest;
    confirm: ConfirmRequest;
    command_id: string;
    expected_preview_hash: string;
    target_session_id: string;
  }): Promise<
    | { ok: true; envelope: CommandEnvelope }
    | { ok: false; error: ErrorEventRelayToOperator }
  > {
    if (args.confirm.preview_hash !== args.expected_preview_hash) {
      return {
        ok: false,
        error: this.makeError(
          args.request.request_id,
          args.command_id,
          "RELAY_PREVIEW_HASH_MISMATCH",
          "ConfirmRequest preview_hash does not match issued ChangeSetPreview",
        ),
      };
    }
    if (!args.confirm.confirm) {
      return {
        ok: false,
        error: this.makeError(
          args.request.request_id,
          args.command_id,
          "RELAY_OPERATOR_DECLINED",
          "Operator declined ChangeSet",
        ),
      };
    }

    const tenantCtx = this.opts.tenantSigning(args.request.tenant_id);
    if (tenantCtx === null) {
      return {
        ok: false,
        error: this.makeError(
          args.request.request_id,
          args.command_id,
          "RELAY_INTERNAL_ERROR",
          "No signing context for tenant",
        ),
      };
    }

    const issued_at = this.now();
    const expires_at = new Date(issued_at.getTime() + 5 * 60 * 1000);
    const nonceBytes = randomBytes(32);
    const nonce = nonceBytes.toString("base64url");

    // operator field for envelope: drop auth_proof per protocol §5.1
    const operatorWithoutAuthProof = stripAuthProof(args.request.operator);

    const envelopeUnsigned: CommandEnvelope = {
      type: "CommandEnvelope",
      command_id: args.command_id,
      tenant_id: args.request.tenant_id,
      target_endpoint_id: args.request.target_endpoint_id,
      correlation_id: args.request.correlation_id,
      session_id: args.target_session_id,
      tool: args.request.tool,
      params: args.request.params,
      operator: operatorWithoutAuthProof as CommandEnvelope["operator"],
      lifecycle_state: "dispatched",
      issued_at: issued_at.toISOString(),
      expires_at: expires_at.toISOString(),
      nonce,
      signing_key_id: tenantCtx.signing_key_id,
      signature_algo: "ed25519-jcs-sha256-v1",
      signature: "",
    };

    const signed = (await signEnvelope(
      SIGN_CONTEXT.COMMAND_ENVELOPE,
      envelopeUnsigned as unknown as SignableEnvelope,
      tenantCtx.private_key,
    )) as unknown as CommandEnvelope;

    // Audit: relay-internal envelope emission
    this.opts.audit.appendCanonical({
      command_id: args.command_id,
      ts: issued_at.toISOString(),
      channel_of_origin: "relay-internal",
      message_type: "CommandEnvelope",
      payload: signed,
      metadata_sidecar: {
        target_endpoint_id: args.request.target_endpoint_id,
        signing_key_id: tenantCtx.signing_key_id,
      },
      endpoint_id: args.request.target_endpoint_id,
      session_id: args.target_session_id,
    });

    // Lifecycle: pending → dispatched
    const transition = this.opts.lifecycle.transition(args.command_id, {
      kind: "dispatch_sent",
    });
    if (!transition.ok) {
      return {
        ok: false,
        error: this.makeError(
          args.request.request_id,
          args.command_id,
          "RELAY_INTERNAL_ERROR",
          `Lifecycle transition failed: ${transition.reason}`,
        ),
      };
    }

    return { ok: true, envelope: signed };
  }

  /**
   * Helper for callers: total dispatch deadline_ms.
   */
  static get T_ACK_TIMEOUT_MS(): number {
    return T_ACK_TIMEOUT_MS;
  }

  // --- helpers --------------------------------------------------------------

  private buildPreviewSummary(request: DispatchRequest): string {
    // Per D20 — generic preview is acceptable for MVP. Tool-specific
    // previews are post-MVP.
    return (
      `Will execute tool '${request.tool}'` +
      ` with params ${JSON.stringify(request.params)}` +
      ` on endpoint ${request.target_endpoint_id}` +
      ` as ${request.operator.kind}:${request.operator.id}`
    );
  }

  private makeError(
    request_id: string,
    command_id: string | null,
    code: string,
    message: string,
  ): ErrorEventRelayToOperator {
    return {
      type: "ErrorEvent",
      request_id,
      command_id,
      code,
      message,
      ts: this.now().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------

/**
 * Compute preview_hash per protocol-v1 §4.2:
 *   sha256(NFC-normalized JCS-canonical(DispatchRequest minus operator.auth_proof) || "|" || preview_summary)
 *
 * The auth_proof is stripped because it's an operator-only credential and
 * doesn't belong in the operator-visible preview surface. Other fields are
 * canonicalized verbatim so both relay and operator agree on the hash.
 */
function computePreviewHash(
  request: DispatchRequest,
  preview_summary: string,
): string {
  const stripped: Record<string, unknown> = JSON.parse(JSON.stringify(request));
  const op = stripped.operator as Record<string, unknown> | undefined;
  if (op && "auth_proof" in op) {
    delete op.auth_proof;
  }
  const canonical = canonicalBytes(stripped);
  const sep = new TextEncoder().encode("|");
  const summaryBytes = new TextEncoder().encode(preview_summary);
  const combined = new Uint8Array(
    canonical.length + sep.length + summaryBytes.length,
  );
  combined.set(canonical, 0);
  combined.set(sep, canonical.length);
  combined.set(summaryBytes, canonical.length + sep.length);
  const hash = sha256(combined);
  return "sha256:" + bytesToHex(hash);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function stripAuthProof(operator: Operator): Omit<Operator, "auth_proof"> {
  const { auth_proof: _strip, ...rest } = operator;
  void _strip;
  return rest as Omit<Operator, "auth_proof">;
}

export { computePreviewHash };
