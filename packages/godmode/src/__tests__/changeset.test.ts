import { describe, it, expect } from "vitest";
import {
  approveChangeSet,
  createChangeSet,
  listChangeSets,
  registerExecutor,
  retryChangeSet,
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
    expect(result.changeset?.status).toBe("executed");
    expect(result.changeset?.approvedBy).toBe("user");
    expect(result.changeset?.executedAt).toBeTypeOf("number");
    expect(result.changeset?.rollbackData).toEqual({
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
    expect(result.changeset?.status).toBe("approved");
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
    expect(result.changeset?.status).toBe("executed");
    expect(result.changeset?.rollbackData).toEqual(rollbackData);
    expect(result.changeset?.approvedBy).toBe("auto");
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

  it("serializes concurrent approve() calls — only one enters the executor", async () => {
    const action = `concurrent-${Math.random()}`;
    let invocations = 0;
    registerExecutor(action, async () => {
      invocations++;
      // Simulate slow executor so the race window is real.
      await new Promise((r) => setTimeout(r, 30));
      return { success: true, message: "applied" };
    });

    const changeset = createDraft({ action });

    const [a, b] = await Promise.all([
      approveChangeSet(changeset.id),
      approveChangeSet(changeset.id),
    ]);

    // Exactly one invocation reached the executor.
    expect(invocations).toBe(1);

    // One caller succeeded; the other was rejected as in-progress or
    // as "not draft" after the first one's initial status flip.
    const successes = [a, b].filter((r) => r.success);
    const failures = [a, b].filter((r) => !r.success);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });

  it("marks failed executor returns as failed (not draft) to prevent silent replay", async () => {
    const action = `executor-fails-${Math.random()}`;
    registerExecutor(action, async () => ({
      success: false,
      message: "upstream 500",
    }));

    const changeset = createDraft({ action });
    const result = await approveChangeSet(changeset.id);

    expect(result.success).toBe(false);
    expect(result.changeset?.status).toBe("failed");

    // Re-approving the same id is refused; operator must explicitly
    // retry to rehydrate.
    const second = await approveChangeSet(changeset.id);
    expect(second.success).toBe(false);
    expect(second.message).toMatch(/not draft|failed/);
  });

  it("marks thrown executor errors as failed (not draft)", async () => {
    const action = `executor-throws-${Math.random()}`;
    registerExecutor(action, async () => {
      throw new Error("boom");
    });

    const changeset = createDraft({ action });
    const result = await approveChangeSet(changeset.id);

    expect(result.success).toBe(false);
    expect(result.changeset?.status).toBe("failed");
  });

  it("retryChangeSet rehydrates a failed changeset back to draft", async () => {
    const action = `retry-cycle-${Math.random()}`;
    let shouldFail = true;
    registerExecutor(action, async () => {
      if (shouldFail) return { success: false, message: "first attempt fails" };
      return { success: true, message: "second attempt wins" };
    });

    const cs = createDraft({ action });
    const first = await approveChangeSet(cs.id);
    expect(first.changeset?.status).toBe("failed");

    // Retrying moves us back to draft.
    const retry = retryChangeSet(cs.id);
    expect(retry.success).toBe(true);
    expect(retry.changeset?.status).toBe("draft");

    // Second attempt now succeeds.
    shouldFail = false;
    const second = await approveChangeSet(cs.id);
    expect(second.success).toBe(true);
    expect(second.changeset?.status).toBe("executed");
  });

  it("retryChangeSet refuses to rehydrate a non-failed changeset", async () => {
    const action = `retry-nonfailed-${Math.random()}`;
    registerExecutor(action, async () => ({
      success: true,
      message: "applied",
    }));

    const cs = createDraft({ action });
    await approveChangeSet(cs.id);

    const retry = retryChangeSet(cs.id);
    expect(retry.success).toBe(false);
    expect(retry.message).toMatch(/cannot retry/);
  });
});
