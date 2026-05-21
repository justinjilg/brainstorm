/**
 * Tests for ChangeSet lifecycle event emission (opus PR 7).
 *
 * Verifies that:
 *  - createChangeSet emits "proposed" with blastRadius
 *  - approveChangeSet emits "approved" then "executed" on success
 *  - approveChangeSet emits "approved" then "failed" on executor failure
 *  - failed emissions don't break ChangeSet execution
 *  - No emitter wired → silent no-op
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createChangeSet,
  approveChangeSet,
  registerExecutor,
  setChangeSetEventEmitter,
  createTestEmitter,
} from "../index.js";

describe("ChangeSet event emission", () => {
  beforeEach(() => {
    setChangeSetEventEmitter(null);
  });
  afterEach(() => {
    setChangeSetEventEmitter(null);
  });

  it("emits 'draft' on createChangeSet with blast radius", () => {
    const capture = createTestEmitter();
    setChangeSetEventEmitter(capture);

    const cs = createChangeSet({
      tenantId: "acme",
      connector: "msp",
      action: `test-${Math.random()}`,
      description: "x",
      changes: [{ system: "msp", entity: "device:1", operation: "update" }],
      simulation: {
        success: true,
        statePreview: {},
        cascades: [],
        constraints: [],
        estimatedDuration: "~1s",
        blastRadius: {
          affectedSymbols: [],
          affectedCommunities: [],
          riskMultiplier: 1,
          totalAffected: 0,
          entitiesAffected: 1,
          productsTouched: ["msp"],
          tenantsTouched: ["acme"],
          dataClasses: ["pii"],
          reversibility: "instant",
        },
      },
    });

    expect(capture.events).toHaveLength(1);
    expect(capture.events[0]?.payload.state).toBe("draft");
    expect(capture.events[0]?.changesetId).toBe(cs.id);
    expect(capture.events[0]?.tenantId).toBe("acme");
    expect(capture.events[0]?.payload.product).toBe("msp");
    expect(capture.events[0]?.payload.blastRadius).toBeDefined();
  });

  it("emits 'approved' then 'executed' on successful approval", async () => {
    const capture = createTestEmitter();
    setChangeSetEventEmitter(capture);

    const action = `success-${Math.random()}`;
    registerExecutor(action, async () => ({
      success: true,
      message: "done",
      rollbackData: { id: "abc" },
    }));

    const cs = createChangeSet({
      tenantId: "acme",
      connector: "msp",
      action,
      description: "x",
      changes: [{ system: "msp", entity: "e", operation: "execute" }],
      simulation: {
        success: true,
        statePreview: {},
        cascades: [],
        constraints: [],
        estimatedDuration: "~0s",
      },
    });

    await approveChangeSet(cs.id);

    const states = capture.events.map((e) => e.payload.state);
    expect(states).toEqual(["draft", "approved", "executed"]);
    expect(capture.events[1]?.payload.approver).toBe("user");
    expect(capture.events[2]?.payload.executionResult).toEqual({ id: "abc" });
  });

  it("emits 'approved' then 'failed' on executor failure", async () => {
    const capture = createTestEmitter();
    setChangeSetEventEmitter(capture);

    const action = `failure-${Math.random()}`;
    registerExecutor(action, async () => ({
      success: false,
      message: "upstream 500",
    }));

    const cs = createChangeSet({
      tenantId: "acme",
      connector: "msp",
      action,
      description: "x",
      changes: [{ system: "msp", entity: "e", operation: "execute" }],
      simulation: {
        success: true,
        statePreview: {},
        cascades: [],
        constraints: [],
        estimatedDuration: "~0s",
      },
    });

    await approveChangeSet(cs.id);

    const states = capture.events.map((e) => e.payload.state);
    expect(states).toEqual(["draft", "approved", "failed"]);
    expect(capture.events[2]?.payload.error).toBe("upstream 500");
  });

  it("emits 'approved' then 'failed' on executor throw", async () => {
    const capture = createTestEmitter();
    setChangeSetEventEmitter(capture);

    const action = `throw-${Math.random()}`;
    registerExecutor(action, async () => {
      throw new Error("boom");
    });

    const cs = createChangeSet({
      tenantId: "acme",
      connector: "msp",
      action,
      description: "x",
      changes: [{ system: "msp", entity: "e", operation: "execute" }],
      simulation: {
        success: true,
        statePreview: {},
        cascades: [],
        constraints: [],
        estimatedDuration: "~0s",
      },
    });

    await approveChangeSet(cs.id);

    const states = capture.events.map((e) => e.payload.state);
    expect(states).toEqual(["draft", "approved", "failed"]);
    expect(capture.events[2]?.payload.error).toContain("boom");
  });

  it("does not break ChangeSet flow when emitter throws (sync)", () => {
    setChangeSetEventEmitter({
      emit() {
        throw new Error("federation bus down");
      },
    });

    // Should NOT throw — the changeset must still be created
    const cs = createChangeSet({
      tenantId: "acme",
      connector: "msp",
      action: `resilient-${Math.random()}`,
      description: "x",
      changes: [{ system: "msp", entity: "e", operation: "update" }],
      simulation: {
        success: true,
        statePreview: {},
        cascades: [],
        constraints: [],
        estimatedDuration: "~0s",
      },
    });

    expect(cs.id).toBeDefined();
    expect(cs.status).toBe("draft");
  });

  it("does not break ChangeSet flow when emitter rejects (async)", () => {
    setChangeSetEventEmitter({
      async emit() {
        throw new Error("federation bus timeout");
      },
    });

    // Async rejection should also not break the sync path
    const cs = createChangeSet({
      tenantId: "acme",
      connector: "msp",
      action: `async-resilient-${Math.random()}`,
      description: "x",
      changes: [{ system: "msp", entity: "e", operation: "update" }],
      simulation: {
        success: true,
        statePreview: {},
        cascades: [],
        constraints: [],
        estimatedDuration: "~0s",
      },
    });

    expect(cs.id).toBeDefined();
  });

  it("is silent no-op when no emitter wired", () => {
    setChangeSetEventEmitter(null);

    const cs = createChangeSet({
      tenantId: "acme",
      connector: "msp",
      action: `no-emitter-${Math.random()}`,
      description: "x",
      changes: [{ system: "msp", entity: "e", operation: "update" }],
      simulation: {
        success: true,
        statePreview: {},
        cascades: [],
        constraints: [],
        estimatedDuration: "~0s",
      },
    });

    // Just confirms no crash
    expect(cs.id).toBeDefined();
  });

  it("propagates correlationId and traceId into events", () => {
    const capture = createTestEmitter();
    setChangeSetEventEmitter(capture);

    createChangeSet({
      tenantId: "acme",
      connector: "msp",
      action: `correlation-${Math.random()}`,
      description: "x",
      changes: [{ system: "msp", entity: "e", operation: "update" }],
      simulation: {
        success: true,
        statePreview: {},
        cascades: [],
        constraints: [],
        estimatedDuration: "~0s",
      },
      correlationId: "incident-2026-05-21-001",
      traceId: "trace-xyz",
    });

    expect(capture.events[0]?.correlationId).toBe("incident-2026-05-21-001");
    expect(capture.events[0]?.traceId).toBe("trace-xyz");
  });
});
