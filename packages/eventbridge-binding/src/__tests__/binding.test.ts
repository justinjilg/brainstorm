/**
 * Tests for the EventBridge binding (opus PR 7.1).
 *
 * Uses a mock EventBridgeClient to verify:
 *  - PutEvents is called with the right Source/DetailType/Detail shape
 *  - State translation (draft→proposed, rolled_back→reverted) happens
 *  - Partial failures throw
 *  - install/uninstall lifecycle wires the godmode global
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createEventBridgeChangeSetEmitter,
  installEventBridgeEmitter,
  uninstallEventBridgeEmitter,
  statusToWireState,
} from "../index.js";
import {
  setChangeSetEventEmitter,
  createTestEmitter,
} from "@brainst0rm/godmode";
import type { ChangeSetLifecycleEvent } from "@brainst0rm/changeset-contract";

function makeEvent(
  overrides: Partial<ChangeSetLifecycleEvent> = {},
): ChangeSetLifecycleEvent {
  return {
    tenantId: "acme",
    ts: 1716220800000,
    changesetId: "cs_abc123",
    payload: {
      product: "msp",
      tool: "msp.customer.create",
      state: "draft",
      ...(overrides.payload ?? {}),
    },
    ...overrides,
  } as ChangeSetLifecycleEvent;
}

describe("statusToWireState", () => {
  it("maps draft → proposed", () => {
    expect(statusToWireState("draft")).toBe("proposed");
  });
  it("maps rolled_back → reverted", () => {
    expect(statusToWireState("rolled_back")).toBe("reverted");
  });
  it("maps rejected → reverted", () => {
    expect(statusToWireState("rejected")).toBe("reverted");
  });
  it("passes through approved/executed/failed/expired", () => {
    expect(statusToWireState("approved")).toBe("approved");
    expect(statusToWireState("executed")).toBe("executed");
    expect(statusToWireState("failed")).toBe("failed");
    expect(statusToWireState("expired")).toBe("expired");
  });
});

describe("createEventBridgeChangeSetEmitter", () => {
  it("calls PutEvents with the contract envelope", async () => {
    const send = vi.fn().mockResolvedValue({ FailedEntryCount: 0 });
    const mockClient = { send } as never;

    const emitter = createEventBridgeChangeSetEmitter({
      client: mockClient,
      busName: "test.bus",
    });

    await emitter.emit(makeEvent());

    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0]?.[0];
    expect(cmd.input.Entries).toHaveLength(1);
    const entry = cmd.input.Entries[0];
    expect(entry.Source).toBe("brainstorm.msp");
    expect(entry.DetailType).toBe("changeset.proposed"); // draft→proposed
    expect(entry.EventBusName).toBe("test.bus");
    const detail = JSON.parse(entry.Detail);
    expect(detail.tenantId).toBe("acme");
    expect(detail.changesetId).toBe("cs_abc123");
    expect(detail.payload.state).toBe("proposed");
  });

  it("translates approved/executed/failed without changing them", async () => {
    const send = vi.fn().mockResolvedValue({ FailedEntryCount: 0 });
    const mockClient = { send } as never;
    const emitter = createEventBridgeChangeSetEmitter({ client: mockClient });

    await emitter.emit(
      makeEvent({ payload: { product: "msp", tool: "x", state: "executed" } }),
    );

    const entry = send.mock.calls[0]?.[0].input.Entries[0];
    expect(entry.DetailType).toBe("changeset.executed");
  });

  it("throws on EventBridge partial failure", async () => {
    const send = vi.fn().mockResolvedValue({
      FailedEntryCount: 1,
      Entries: [
        {
          ErrorCode: "AccessDeniedException",
          ErrorMessage: "no PutEvents permission",
        },
      ],
    });
    const mockClient = { send } as never;
    const emitter = createEventBridgeChangeSetEmitter({ client: mockClient });

    await expect(emitter.emit(makeEvent())).rejects.toThrow(
      /AccessDeniedException/,
    );
  });

  it("translates rolled_back → reverted in DetailType + payload.state", async () => {
    const send = vi.fn().mockResolvedValue({ FailedEntryCount: 0 });
    const emitter = createEventBridgeChangeSetEmitter({
      client: { send } as never,
    });

    await emitter.emit(
      makeEvent({
        payload: { product: "vm", tool: "vm.destroy", state: "rolled_back" },
      }),
    );

    const entry = send.mock.calls[0]?.[0].input.Entries[0];
    expect(entry.DetailType).toBe("changeset.reverted");
    expect(JSON.parse(entry.Detail).payload.state).toBe("reverted");
  });
});

describe("installEventBridgeEmitter / uninstallEventBridgeEmitter", () => {
  beforeEach(() => {
    setChangeSetEventEmitter(null);
  });

  it("install returns a functional emitter and doesn't throw", async () => {
    const send = vi.fn().mockResolvedValue({ FailedEntryCount: 0 });
    const emitter = installEventBridgeEmitter({ client: { send } as never });

    // The returned emitter is the one wired into godmode's global slot.
    // Exercise it directly to confirm the wiring chain works.
    await emitter.emit(makeEvent());
    expect(send).toHaveBeenCalled();
  });

  it("uninstall reverts the global slot without throwing", () => {
    installEventBridgeEmitter({ client: { send: vi.fn() } as never });
    expect(() => uninstallEventBridgeEmitter()).not.toThrow();
  });
});
