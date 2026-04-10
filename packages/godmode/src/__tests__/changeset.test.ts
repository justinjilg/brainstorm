import { describe, it, expect } from "vitest";
import {
  approveChangeSet,
  createChangeSet,
  listChangeSets,
  registerExecutor,
} from "../changeset";
import { getAuditLog } from "../audit";
import type { Change, SimulationResult } from "../types";

describe("ChangeSet state machine", () => {
  function createSimulation(
    overrides: Partial<SimulationResult> = {},
  ): SimulationResult {
    return {
      success: true,
      statePreview: { status: "ready" },
      cascades: [],
      constraints: [],
      estimatedDuration: "30s",
      ...overrides,
    };
  }

  function createChanges(overrides: Partial<Change> = {}): Change[] {
    return [
      {
        system: "msp",
        entity: "device:alpha",
        operation: "update",
        before: { status: "old" },
        after: { status: "new" },
        ...overrides,
      },
    ];
  }

  function createDraft(options?: {
    connector?: string;
    action?: string;
    changes?: Change[];
    simulation?: SimulationResult;
  }) {
    return createChangeSet({
      connector: options?.connector ?? "msp",
      action: options?.action ?? `test-action-${Math.random()}`,
      description: "Apply a controlled state change",
      changes: options?.changes ?? createChanges(),
      simulation: options?.simulation ?? createSimulation(),
    });
  }

  it("createChangeSet produces a pending draft state", () => {
    const changeset = createDraft();

    expect(changeset.status).toBe("draft");
    expect(changeset.id).toHaveLength(8);
    expect(changeset.riskScore).toBeGreaterThan(0);
    expect(changeset.expiresAt).toBeGreaterThan(changeset.createdAt);
    expect(listChangeSets().some((entry) => entry.id === changeset.id)).toBe(
      true,
    );
  });

  it("transitions from draft to approved to executed when an executor succeeds", async () => {
    const action = `approve-success-${Math.random()}`;
    registerExecutor(action, async () => ({
      success: true,
      message: "Applied successfully",
      rollbackData: { undo: "restore previous value" },
    }));

    const changeset = createDraft({ action });
    expect(changeset.status).toBe("draft");

    const result = await approveChangeSet(changeset.id);

    expect(result.success).toBe(true);
    expect(result.changeset.status).toBe("executed");
    expect(result.changeset.approvedBy).toBe("user");
    expect(result.changeset.executedAt).toBeTypeOf("number");
    expect(result.changeset.rollbackData).toEqual({
      undo: "restore previous value",
    });
  });

  it("rejects execution when no executor is registered", async () => {
    const changeset = createDraft({
      action: `missing-executor-${Math.random()}`,
    });

    const result = await approveChangeSet(changeset.id);

    expect(result.success).toBe(false);
    expect(result.message).toContain("No executor registered");
    expect(result.changeset.status).toBe("approved");
  });

  it("preserves rollback data after execution so the executed state can be reversed", async () => {
    const action = `rollback-ready-${Math.random()}`;
    const rollbackData = {
      restoreEntity: "device:alpha",
      previousState: { status: "old" },
    };

    registerExecutor(action, async () => ({
      success: true,
      message: "Executed with rollback support",
      rollbackData,
    }));

    const changeset = createDraft({ action });
    const result = await approveChangeSet(changeset.id, "auto");

    expect(result.success).toBe(true);
    expect(result.changeset.status).toBe("executed");
    expect(result.changeset.rollbackData).toEqual(rollbackData);
    expect(result.changeset.approvedBy).toBe("auto");
  });

  it("assesses blast radius through risk score and risk factors", () => {
    const changes = [
      ...Array.from({ length: 6 }, (_, index) => ({
        system: "vm",
        entity: `instance:${index}`,
        operation: "delete" as const,
        before: { state: "running" },
        after: undefined,
      })),
    ];
    const simulation = createSimulation({
      cascades: [
        "autoscaling group shrinks",
        "load balancer target count drops",
      ],
      constraints: ["maintenance window required"],
    });

    const changeset = createDraft({
      connector: "vm",
      changes,
      simulation,
    });

    expect(changeset.riskScore).toBe(100);
    expect(changeset.riskFactors).toEqual(
      expect.arrayContaining([
        "6 delete operation(s)",
        "6 entities affected",
        "2 cascade effect(s): autoscaling group shrinks, load balancer target count drops",
        "Infrastructure-level changes",
        "1 constraint(s) to check",
      ]),
    );
  });

  it("audits executed changesets", async () => {
    const action = `audit-success-${Math.random()}`;
    registerExecutor(action, async () => ({
      success: true,
      message: "Executed and audited",
      rollbackData: { ticket: "rb-1" },
    }));

    const changeset = createDraft({ action });
    const auditCountBefore = getAuditLog().length;

    const result = await approveChangeSet(changeset.id);

    expect(result.success).toBe(true);
    const auditLog = getAuditLog();
    expect(auditLog.length).toBe(auditCountBefore + 1);
    expect(auditLog.at(-1)).toMatchObject({
      changesetId: changeset.id,
      action,
      status: "executed",
    });
  });
});
