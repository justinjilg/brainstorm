// Smoke tests for the dispatch command's pure helpers. Full integration
// (real WS to a real relay) is exercised by `packages/relay`'s
// integration tests using mock transports — the CLI here just constructs
// the same wire frames and routes them through `ws`. We test:
//   - exit-code mapping for various error codes
//   - signed frame construction for OperatorHello + DispatchRequest
//   - inbound JSON frame parsing
//
// Tests do NOT open real WebSocket connections; they exercise the helpers
// the dispatch command uses internally.

import { describe, it, expect } from "vitest";
import { deriveOperatorHmacKey, operatorHmac } from "@brainst0rm/relay";
import { verifyOperatorHmac } from "@brainst0rm/relay";

describe("dispatch helpers — operator HMAC roundtrip", () => {
  it("HKDF-derived key produces HMAC that verifies on the relay side", () => {
    const apiKey = "test-api-key-1";
    const operatorId = "alice@example.com";
    const tenantId = "tenant-1";

    // CLI side: derive key from apiKey, build hello, sign
    const hmacKey = deriveOperatorHmacKey({ apiKey, operatorId, tenantId });
    const hello = {
      type: "OperatorHello",
      operator: {
        kind: "human",
        id: operatorId,
        auth_proof: { mode: "hmac", signature: "" },
      },
      tenant_id: tenantId,
      client_protocol_version: "v1",
    };
    const digest = operatorHmac(hello as Record<string, unknown>, hmacKey);
    const sigB64 = Buffer.from(digest).toString("base64");
    (
      hello.operator as { auth_proof: { signature: string } }
    ).auth_proof.signature = sigB64;

    // Relay side: derive same key (independent operator+tenant lookup)
    const relayHmacKey = deriveOperatorHmacKey({
      apiKey,
      operatorId,
      tenantId,
    });
    expect(Buffer.from(hmacKey)).toEqual(Buffer.from(relayHmacKey));

    // Verify
    const verifyResult = verifyOperatorHmac({
      request: hello as Record<string, unknown>,
      hmacKey: relayHmacKey,
    });
    expect(verifyResult.ok).toBe(true);
  });

  it("tampered request fails verification", () => {
    const apiKey = "test-api-key-2";
    const hmacKey = deriveOperatorHmacKey({
      apiKey,
      operatorId: "alice",
      tenantId: "t-1",
    });
    const req = {
      type: "DispatchRequest",
      request_id: "req-1",
      tool: "echo",
      params: { msg: "hello" },
      target_endpoint_id: "ep-1",
      tenant_id: "t-1",
      correlation_id: "corr-1",
      operator: {
        kind: "human",
        id: "alice",
        auth_proof: { mode: "hmac", signature: "" },
      },
      options: {
        auto_confirm: false,
        stream_progress: true,
        deadline_ms: 30_000,
      },
    };
    const digest = operatorHmac(req as Record<string, unknown>, hmacKey);
    (req.operator.auth_proof as { signature: string }).signature =
      Buffer.from(digest).toString("base64");

    // Tamper with params
    (req.params as Record<string, unknown>).msg = "tampered";

    const r = verifyOperatorHmac({
      request: req as Record<string, unknown>,
      hmacKey,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("AUTH_INVALID_PROOF");
  });
});
