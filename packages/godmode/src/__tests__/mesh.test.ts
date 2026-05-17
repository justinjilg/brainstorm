import { describe, it, expect, beforeEach } from "vitest";
import {
  InMemorySeenStore,
  InMemoryTaskStore,
  MeshBroker,
  formatTraceparent,
  newRootTraceparent,
  nextSpan,
  parseTraceparent,
  type AgentJWTClaims,
  type CapabilityResolver,
  type Dispatcher,
  type DispatchOutcome,
  type JWTVerifier,
  type MeshBrokerConfig,
  type MeshInvokeInput,
} from "../mesh/index.js";

function buildBroker(overrides?: Partial<MeshBrokerConfig>): MeshBroker {
  const cfg: MeshBrokerConfig = {
    seenStore: new InMemorySeenStore(),
    taskStore: new InMemoryTaskStore(),
    resolver: stubResolver({ status: "active", tenantId: "tenant-1" }),
    dispatcher: stubDispatcher({
      kind: "sync",
      output: { ok: true },
      evidence_envelope_hash: "deadbeef",
      completed_at: new Date().toISOString(),
    }),
    jwt: stubJWT({
      sub: "did:bvm:tenant-1:caller",
      tenant_id: "tenant-1",
      capabilities: ["agent.summarize_text"],
    }),
    statusUrlPrefix: "/v1/mesh/task",
    ...overrides,
  };
  return new MeshBroker(cfg);
}

function validInput(overrides?: Partial<MeshInvokeInput>): MeshInvokeInput {
  return {
    targetDID: "did:bvm:tenant-1:writer",
    authorizationHeader: "Bearer fake.jwt.token",
    traceparentHeader: formatTraceparent(newRootTraceparent()),
    tracestateHeader: null,
    idempotencyKeyHeader: "11111111-1111-1111-1111-000000000001",
    body: {
      task_id: "22222222-2222-2222-2222-000000000002",
      capability: "agent.summarize_text",
      input: { text: "hello" },
    },
    ...overrides,
  };
}

function stubResolver(
  result: {
    status: "active" | "deprecated" | "removed";
    tenantId: string;
  } | null,
): CapabilityResolver {
  return {
    async resolve() {
      return result;
    },
  };
}

function stubDispatcher(outcome: DispatchOutcome): Dispatcher {
  return {
    async dispatch() {
      return outcome;
    },
  };
}

function stubJWT(claims: AgentJWTClaims | null): JWTVerifier {
  return {
    async verify() {
      return claims;
    },
  };
}

describe("MeshBroker.invoke happy paths", () => {
  it("returns 200 sync response when dispatcher resolves synchronously", async () => {
    const broker = buildBroker();
    const result = await broker.invoke(validInput());
    expect(result.status).toBe(200);
    expect((result.body as any).task_id).toBe(
      "22222222-2222-2222-2222-000000000002",
    );
    expect((result.body as any).traceparent).toBeTruthy();
  });

  it("returns 202 + status_url when dispatcher reports async", async () => {
    const broker = buildBroker({
      dispatcher: stubDispatcher({ kind: "async" }),
    });
    const result = await broker.invoke(validInput());
    expect(result.status).toBe(202);
    expect((result.body as any).status_url).toContain("/v1/mesh/task/");
  });

  it("propagates trace_id while assigning a new span_id downstream", async () => {
    const root = newRootTraceparent();
    const broker = buildBroker();
    const result = await broker.invoke(
      validInput({ traceparentHeader: formatTraceparent(root) }),
    );
    expect(result.status).toBe(200);
    const downstream = parseTraceparent((result.body as any).traceparent);
    expect(downstream).not.toBeNull();
    expect(downstream!.trace_id).toBe(root.trace_id);
    expect(downstream!.span_id).not.toBe(root.span_id);
  });
});

describe("MeshBroker.invoke validation", () => {
  it("rejects missing traceparent with 400 VALIDATION", async () => {
    const broker = buildBroker();
    const result = await broker.invoke(validInput({ traceparentHeader: null }));
    expect(result.status).toBe(400);
    expect((result.body as any).code).toBe("VALIDATION");
  });

  it("rejects malformed traceparent with 400 VALIDATION", async () => {
    const broker = buildBroker();
    const result = await broker.invoke(
      validInput({ traceparentHeader: "not-a-traceparent" }),
    );
    expect(result.status).toBe(400);
  });

  it("rejects missing Idempotency-Key with 400 VALIDATION", async () => {
    const broker = buildBroker();
    const result = await broker.invoke(
      validInput({ idempotencyKeyHeader: null }),
    );
    expect(result.status).toBe(400);
  });

  it("rejects missing Bearer auth with 401 UNAUTHORIZED", async () => {
    const broker = buildBroker();
    const result = await broker.invoke(
      validInput({ authorizationHeader: null }),
    );
    expect(result.status).toBe(401);
  });

  it("rejects malformed auth header with 401 UNAUTHORIZED", async () => {
    const broker = buildBroker();
    const result = await broker.invoke(
      validInput({ authorizationHeader: "Basic abc" }),
    );
    expect(result.status).toBe(401);
  });

  it("rejects non-agent capability with 400 VALIDATION", async () => {
    const broker = buildBroker();
    const result = await broker.invoke(
      validInput({
        body: {
          task_id: "x",
          capability: "vm.create_instance",
          input: {},
        },
      }),
    );
    expect(result.status).toBe(400);
  });

  it("rejects missing input with 400 VALIDATION", async () => {
    const broker = buildBroker();
    const result = await broker.invoke(
      validInput({
        body: {
          task_id: "x",
          capability: "agent.summarize_text",
        } as any,
      }),
    );
    expect(result.status).toBe(400);
  });
});

describe("MeshBroker.invoke replay protection", () => {
  let seen: InMemorySeenStore;
  beforeEach(() => {
    seen = new InMemorySeenStore();
  });

  it("first call with a key succeeds; duplicate returns 409 with original task_id", async () => {
    const broker = buildBroker({ seenStore: seen });
    const first = await broker.invoke(validInput());
    expect(first.status).toBe(200);

    // Same idempotency key, different task_id → must 409.
    const dup = await broker.invoke(
      validInput({
        body: {
          task_id: "33333333-3333-3333-3333-000000000003",
          capability: "agent.summarize_text",
          input: { text: "different" },
        },
      }),
    );
    expect(dup.status).toBe(409);
    expect((dup.body as any).code).toBe("CONFLICT");
    expect((dup.body as any).task_id).toBe(
      "22222222-2222-2222-2222-000000000002",
    );
  });

  it("different idempotency keys do not collide", async () => {
    const broker = buildBroker({ seenStore: seen });
    const r1 = await broker.invoke(validInput());
    const r2 = await broker.invoke(
      validInput({
        idempotencyKeyHeader: "44444444-4444-4444-4444-000000000004",
      }),
    );
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });
});

describe("MeshBroker.invoke authorization", () => {
  it("rejects when JWT capabilities[] does not include requested capability (403)", async () => {
    const broker = buildBroker({
      jwt: stubJWT({
        sub: "did:bvm:tenant-1:caller",
        tenant_id: "tenant-1",
        capabilities: ["agent.something_else"],
      }),
    });
    const result = await broker.invoke(validInput());
    expect(result.status).toBe(403);
    expect((result.body as any).code).toBe("FORBIDDEN");
  });

  it("rejects when caller tenant differs from target tenant (403)", async () => {
    const broker = buildBroker({
      jwt: stubJWT({
        sub: "did:bvm:other-tenant:caller",
        tenant_id: "other-tenant",
        capabilities: ["agent.summarize_text"],
      }),
    });
    const result = await broker.invoke(validInput());
    expect(result.status).toBe(403);
  });

  it("rejects when JWT verification fails (401)", async () => {
    const broker = buildBroker({ jwt: stubJWT(null) });
    const result = await broker.invoke(validInput());
    expect(result.status).toBe(401);
  });
});

describe("MeshBroker.invoke capability resolution", () => {
  it("404 NOT_FOUND when target has no such capability", async () => {
    const broker = buildBroker({ resolver: stubResolver(null) });
    const result = await broker.invoke(validInput());
    expect(result.status).toBe(404);
  });

  it("404 NOT_FOUND when target capability is deprecated", async () => {
    const broker = buildBroker({
      resolver: stubResolver({ status: "deprecated", tenantId: "tenant-1" }),
    });
    const result = await broker.invoke(validInput());
    expect(result.status).toBe(404);
  });

  it("404 NOT_FOUND when target capability is removed", async () => {
    const broker = buildBroker({
      resolver: stubResolver({ status: "removed", tenantId: "tenant-1" }),
    });
    const result = await broker.invoke(validInput());
    expect(result.status).toBe(404);
  });
});

describe("MeshBroker.getTask", () => {
  it("returns 404 for unknown task_id", async () => {
    const broker = buildBroker();
    const r = await broker.getTask("nonexistent");
    expect(r.status).toBe(404);
  });

  it("returns 200 with sync result after completion", async () => {
    const broker = buildBroker({
      dispatcher: stubDispatcher({ kind: "async" }),
    });
    const accept = await broker.invoke(validInput());
    expect(accept.status).toBe(202);
    const taskId = (accept.body as any).task_id;

    // Simulate the dispatcher completing the task.
    const { taskStore } = broker as any;
    // Reach into the underlying store via the broker config — we kept it
    // private but test code reaches in to simulate the completion.
    // (Production dispatchers would call completeTask directly.)
    const cfg = (broker as any).cfg as MeshBrokerConfig;
    const completion = {
      task_id: taskId,
      output: { done: true },
      evidence_envelope_hash: "abcd1234",
      completed_at: new Date().toISOString(),
      traceparent: (accept.body as any).traceparent,
    };
    await cfg.taskStore.transition(taskId, "completed", { result: completion });

    const final = await broker.getTask(taskId);
    expect(final.status).toBe(200);
    expect((final.body as any).output).toEqual({ done: true });
    void taskStore;
  });
});

describe("trace-context helpers", () => {
  it("parseTraceparent rejects all-zero trace_id", () => {
    const bad = "00-00000000000000000000000000000000-0000000000000001-01";
    expect(parseTraceparent(bad)).toBeNull();
  });

  it("parseTraceparent rejects all-zero span_id", () => {
    const bad = "00-00000000000000000000000000000001-0000000000000000-01";
    expect(parseTraceparent(bad)).toBeNull();
  });

  it("nextSpan keeps trace_id but assigns fresh span_id", () => {
    const root = newRootTraceparent();
    const next = nextSpan(root);
    expect(next.trace_id).toBe(root.trace_id);
    expect(next.span_id).not.toBe(root.span_id);
  });

  it("formatTraceparent + parseTraceparent roundtrip", () => {
    const root = newRootTraceparent();
    const s = formatTraceparent(root);
    const parsed = parseTraceparent(s);
    expect(parsed).toEqual(root);
  });
});

describe("InMemorySeenStore", () => {
  it("first call returns firstTime=true", async () => {
    const store = new InMemorySeenStore();
    const r = await store.seeOrFetch("k1", "task-1");
    expect(r.firstTime).toBe(true);
  });

  it("duplicate within TTL returns the original task id", async () => {
    const store = new InMemorySeenStore();
    await store.seeOrFetch("k1", "task-1");
    const r = await store.seeOrFetch("k1", "task-2");
    expect(r.firstTime).toBe(false);
    expect(
      (r as { firstTime: false; existingTaskId: string }).existingTaskId,
    ).toBe("task-1");
  });

  it("evicts entries older than TTL", async () => {
    const store = new InMemorySeenStore({ ttlMs: 10 });
    await store.seeOrFetch("k1", "task-1");
    await new Promise((r) => setTimeout(r, 30));
    const r = await store.seeOrFetch("k1", "task-2");
    expect(r.firstTime).toBe(true);
  });
});
