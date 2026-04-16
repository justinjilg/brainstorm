import { describe, it, expect } from "vitest";
import {
  signEvent,
  verifyEvent,
  createSignedEvent,
  deriveTenantKey,
  canonicalize,
} from "../signing";

describe("Platform Event Signing", () => {
  const MASTER_SECRET = "test-secret-for-unit-tests";
  const TENANT_ID = "tenant-abc-123";

  describe("canonicalize", () => {
    it("sorts keys deterministically", () => {
      const a = canonicalize({ z: 1, a: 2, m: 3 });
      const b = canonicalize({ a: 2, m: 3, z: 1 });
      expect(a).toBe(b);
    });

    it("produces compact JSON (no whitespace)", () => {
      const result = canonicalize({ key: "value", num: 42 });
      expect(result).not.toContain(" ");
      expect(result).toContain('"key":"value"');
    });
  });

  describe("deriveTenantKey", () => {
    it("produces different keys for different tenants", () => {
      const key1 = deriveTenantKey(MASTER_SECRET, "tenant-a");
      const key2 = deriveTenantKey(MASTER_SECRET, "tenant-b");
      expect(key1).not.toEqual(key2);
    });

    it("produces 32-byte keys", () => {
      const key = deriveTenantKey(MASTER_SECRET, TENANT_ID);
      expect(key.length).toBe(32);
    });

    it("is deterministic for same inputs", () => {
      const key1 = deriveTenantKey(MASTER_SECRET, TENANT_ID);
      const key2 = deriveTenantKey(MASTER_SECRET, TENANT_ID);
      expect(key1).toEqual(key2);
    });
  });

  describe("signEvent / verifyEvent", () => {
    it("signs and verifies a valid event", () => {
      const event = {
        id: "evt-1",
        type: "msp.alert.created",
        tenant_id: TENANT_ID,
        product: "msp",
        timestamp: new Date().toISOString(),
        data: { severity: "high" },
        schema_version: 1,
      };

      const signature = signEvent(event, MASTER_SECRET);
      expect(typeof signature).toBe("string");
      expect(signature.length).toBe(64); // SHA-256 hex

      const signedEvent = { ...event, signature };
      expect(verifyEvent(signedEvent, MASTER_SECRET)).toBe(true);
    });

    it("rejects tampered event", () => {
      const event = {
        id: "evt-2",
        type: "msp.alert.created",
        tenant_id: TENANT_ID,
        product: "msp",
        timestamp: new Date().toISOString(),
        data: { severity: "low" },
        schema_version: 1,
      };

      const signature = signEvent(event, MASTER_SECRET);
      const tampered = { ...event, data: { severity: "critical" }, signature };
      expect(verifyEvent(tampered, MASTER_SECRET)).toBe(false);
    });

    it("rejects event with wrong master secret", () => {
      const event = {
        id: "evt-3",
        type: "test",
        tenant_id: TENANT_ID,
        product: "msp",
        timestamp: new Date().toISOString(),
        data: {},
        schema_version: 1,
      };

      const signature = signEvent(event, MASTER_SECRET);
      const signedEvent = { ...event, signature };
      expect(verifyEvent(signedEvent, "wrong-secret")).toBe(false);
    });

    it("rejects event without signature", () => {
      const event = {
        id: "evt-4",
        type: "test",
        tenant_id: TENANT_ID,
        product: "msp",
        timestamp: new Date().toISOString(),
        data: {},
        schema_version: 1,
        signature: "",
      };
      expect(verifyEvent(event as any, MASTER_SECRET)).toBe(false);
    });
  });

  describe("createSignedEvent", () => {
    it("creates a verifiable signed event", () => {
      const event = createSignedEvent(
        "msp.agent.enrolled",
        TENANT_ID,
        "msp",
        { agent_id: "agent-1" },
        MASTER_SECRET,
      );

      expect(event.type).toBe("msp.agent.enrolled");
      expect(event.tenant_id).toBe(TENANT_ID);
      expect(event.signature).toBeTruthy();
      expect(verifyEvent(event, MASTER_SECRET)).toBe(true);
    });

    it("includes correlation_id when provided", () => {
      const event = createSignedEvent(
        "test",
        TENANT_ID,
        "msp",
        {},
        MASTER_SECRET,
        { correlationId: "corr-123" },
      );
      expect(event.correlation_id).toBe("corr-123");
      expect(verifyEvent(event, MASTER_SECRET)).toBe(true);
    });
  });

  describe("replay freshness", () => {
    const baseEvent = {
      id: "evt-freshness",
      type: "msp.alert.created",
      tenant_id: TENANT_ID,
      product: "msp",
      data: {},
      schema_version: 1,
    };

    it("rejects an event with no timestamp", () => {
      const unsigned = { ...baseEvent, timestamp: "" } as Omit<
        Parameters<typeof signEvent>[0],
        "signature"
      > & { timestamp: string };
      const sig = signEvent(unsigned, MASTER_SECRET);
      expect(verifyEvent({ ...unsigned, signature: sig }, MASTER_SECRET)).toBe(
        false,
      );
    });

    it("rejects an event whose timestamp does not parse as a date", () => {
      const bad = { ...baseEvent, timestamp: "not-a-date" };
      const sig = signEvent(bad, MASTER_SECRET);
      expect(verifyEvent({ ...bad, signature: sig }, MASTER_SECRET)).toBe(
        false,
      );
    });

    it("rejects an event older than the freshness window", () => {
      const old = {
        ...baseEvent,
        timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      };
      const sig = signEvent(old, MASTER_SECRET);
      expect(verifyEvent({ ...old, signature: sig }, MASTER_SECRET)).toBe(
        false,
      );
    });

    it("accepts an event inside the freshness window", () => {
      const fresh = { ...baseEvent, timestamp: new Date().toISOString() };
      const sig = signEvent(fresh, MASTER_SECRET);
      expect(verifyEvent({ ...fresh, signature: sig }, MASTER_SECRET)).toBe(
        true,
      );
    });
  });
});
