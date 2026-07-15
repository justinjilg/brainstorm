/**
 * Approval friction — per-instance warning isolation.
 *
 * Pre-fix regression: a single module-level `_pendingWarning` was shared
 * across every middleware instance in the process. In multi-session
 * deployments, one session's velocity warning could be consumed and
 * attached to an unrelated session's next tool result. Post-fix, pending
 * warnings are keyed by each instance's own velocity tracker (a WeakMap),
 * so a warning is consumed only by the session whose tracker produced it.
 */

import { describe, it, expect } from "vitest";
import {
  createApprovalFrictionMiddleware,
  recordApprovalDecision,
  getApprovalTracker,
} from "../middleware/builtin/approval-friction.js";

const RESULT = {
  toolCallId: "call-1",
  name: "shell",
  ok: true,
  output: { stdout: "done" },
  durationMs: 0,
};

/** Drive a tracker into producing a rapid-approval warning. */
function triggerWarning(tracker: any) {
  let warning = null;
  for (let i = 0; i < 3; i++) {
    warning = recordApprovalDecision(tracker, "shell", "approve", 100);
  }
  return warning;
}

describe("approval-friction — warning isolation", () => {
  it("does not let one instance consume another instance's warning", () => {
    const mwA = createApprovalFrictionMiddleware();
    const mwB = createApprovalFrictionMiddleware();

    const metaA: Record<string, unknown> = {};
    const metaB: Record<string, unknown> = {};
    mwA.beforeAgent!({ metadata: metaA } as any);
    mwB.beforeAgent!({ metadata: metaB } as any);

    const trackerA = getApprovalTracker(metaA)!;
    expect(trackerA).toBeTruthy();

    // Fire a warning against A's tracker only.
    const warning = triggerWarning(trackerA);
    expect(warning).not.toBeNull();

    // B's afterToolResult must NOT attach A's warning.
    const bResult = mwB.afterToolResult!({ ...RESULT }) as any;
    expect(bResult).toBeFalsy();

    // A's afterToolResult DOES attach it.
    const aResult = mwA.afterToolResult!({ ...RESULT }) as any;
    expect(aResult).toBeTruthy();
    expect(aResult.output._approval_warning).toBe(warning!.message);
    expect(aResult.output._cooling_ms).toBe(warning!.coolingMs);
    expect(aResult.output._rapid_count).toBe(warning!.rapidCount);
  });

  it("consumes the warning once (second afterToolResult is a no-op)", () => {
    const mw = createApprovalFrictionMiddleware();
    const meta: Record<string, unknown> = {};
    mw.beforeAgent!({ metadata: meta } as any);
    const tracker = getApprovalTracker(meta)!;

    triggerWarning(tracker);
    expect(mw.afterToolResult!({ ...RESULT })).toBeTruthy();
    expect(mw.afterToolResult!({ ...RESULT })).toBeFalsy();
  });
});
