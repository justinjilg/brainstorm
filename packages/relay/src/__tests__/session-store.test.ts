import { describe, it, expect } from "vitest";
import { SessionStore, type TransportHandle } from "../session-store.js";

function fakeTransport(): TransportHandle {
  let alive = true;
  return {
    async send(_frame) {},
    async close(_reason) {
      alive = false;
    },
    isAlive() {
      return alive;
    },
  };
}

describe("SessionStore — operator sessions", () => {
  it("registers and retrieves an operator session", () => {
    const store = new SessionStore();
    store.registerOperator({
      operator_session_id: "op-1",
      operator: {
        kind: "human",
        id: "alice",
        auth_proof: { kind: "hmac_signed_envelope", signature: "x" },
      },
      tenant_id: "tenant-1",
      opened_at: new Date().toISOString(),
      transport: fakeTransport(),
      inflight_request_ids: new Set(),
    });
    expect(store.getOperator("op-1")).toBeDefined();
    expect(store.countOperators()).toBe(1);
  });

  it("rejects duplicate operator_session_id", () => {
    const store = new SessionStore();
    const session = {
      operator_session_id: "op-1",
      operator: {
        kind: "human" as const,
        id: "alice",
        auth_proof: { kind: "hmac_signed_envelope" as const, signature: "x" },
      },
      tenant_id: "tenant-1",
      opened_at: new Date().toISOString(),
      transport: fakeTransport(),
      inflight_request_ids: new Set<string>(),
    };
    store.registerOperator(session);
    expect(() => store.registerOperator(session)).toThrow(/already registered/);
  });

  it("removes operator session", () => {
    const store = new SessionStore();
    store.registerOperator({
      operator_session_id: "op-1",
      operator: {
        kind: "human",
        id: "alice",
        auth_proof: { kind: "hmac_signed_envelope", signature: "x" },
      },
      tenant_id: "tenant-1",
      opened_at: new Date().toISOString(),
      transport: fakeTransport(),
      inflight_request_ids: new Set(),
    });
    store.removeOperator("op-1");
    expect(store.getOperator("op-1")).toBeUndefined();
    expect(store.countOperators()).toBe(0);
  });
});

describe("SessionStore — endpoint sessions", () => {
  function makeSession(opts: { session_id: string; endpoint_id: string }) {
    return {
      session_id: opts.session_id,
      endpoint_id: opts.endpoint_id,
      tenant_id: "tenant-1",
      opened_at: new Date().toISOString(),
      transport: fakeTransport(),
      inflight_command_ids: new Set<string>(),
    };
  }

  it("registers a new endpoint session", () => {
    const store = new SessionStore();
    const prior = store.registerEndpoint(
      makeSession({ session_id: "s-1", endpoint_id: "ep-1" }),
    );
    expect(prior).toBeNull();
    expect(store.countEndpoints()).toBe(1);
    expect(store.getActiveEndpointSession("ep-1")?.session_id).toBe("s-1");
  });

  it("reconnect: replaces prior session for same endpoint_id, returns prior", () => {
    const store = new SessionStore();
    const first = makeSession({ session_id: "s-1", endpoint_id: "ep-1" });
    store.registerEndpoint(first);
    const second = makeSession({ session_id: "s-2", endpoint_id: "ep-1" });
    const replaced = store.registerEndpoint(second);
    expect(replaced).not.toBeNull();
    expect(replaced?.session_id).toBe("s-1");
    expect(store.countEndpoints()).toBe(1); // first was removed
    expect(store.getActiveEndpointSession("ep-1")?.session_id).toBe("s-2");
    // s-1 is no longer current
    expect(store.isCurrentSession("ep-1", "s-1")).toBe(false);
    expect(store.isCurrentSession("ep-1", "s-2")).toBe(true);
  });

  it("isCurrentSession identifies stale-session frames", () => {
    const store = new SessionStore();
    store.registerEndpoint(
      makeSession({ session_id: "s-1", endpoint_id: "ep-1" }),
    );
    store.registerEndpoint(
      makeSession({ session_id: "s-2", endpoint_id: "ep-1" }),
    );
    // A frame arriving with session_id=s-1 from endpoint ep-1 is stale;
    // relay should reject with SESSION_STALE per protocol §2.
    expect(store.isCurrentSession("ep-1", "s-1")).toBe(false);
    expect(store.isCurrentSession("ep-1", "s-2")).toBe(true);
    // Endpoint that doesn't exist
    expect(store.isCurrentSession("ep-other", "s-1")).toBe(false);
  });

  it("rejects duplicate session_id even across endpoints", () => {
    const store = new SessionStore();
    store.registerEndpoint(
      makeSession({ session_id: "s-1", endpoint_id: "ep-1" }),
    );
    expect(() =>
      store.registerEndpoint(
        makeSession({ session_id: "s-1", endpoint_id: "ep-2" }),
      ),
    ).toThrow(/already registered/);
  });

  it("removeEndpoint clears the active session for that endpoint", () => {
    const store = new SessionStore();
    store.registerEndpoint(
      makeSession({ session_id: "s-1", endpoint_id: "ep-1" }),
    );
    store.removeEndpoint("s-1");
    expect(store.getActiveEndpointSession("ep-1")).toBeUndefined();
    expect(store.countEndpoints()).toBe(0);
  });

  it("removeEndpoint of stale session does NOT clear newer endpoint mapping", () => {
    const store = new SessionStore();
    store.registerEndpoint(
      makeSession({ session_id: "s-1", endpoint_id: "ep-1" }),
    );
    store.registerEndpoint(
      makeSession({ session_id: "s-2", endpoint_id: "ep-1" }),
    );
    // s-1 was replaced; explicit removal of s-1 (after replacement) should
    // not clobber the s-2 mapping.
    store.removeEndpoint("s-1");
    // s-1 was already gone, but ep-1 → s-2 mapping must persist
    expect(store.getActiveEndpointSession("ep-1")?.session_id).toBe("s-2");
  });

  it("activeEndpointIds returns one entry per active endpoint", () => {
    const store = new SessionStore();
    store.registerEndpoint(
      makeSession({ session_id: "s-1", endpoint_id: "ep-a" }),
    );
    store.registerEndpoint(
      makeSession({ session_id: "s-2", endpoint_id: "ep-b" }),
    );
    expect(store.activeEndpointIds().sort()).toEqual(["ep-a", "ep-b"]);
  });
});
