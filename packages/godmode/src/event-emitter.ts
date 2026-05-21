/**
 * ChangeSet event emission — lifecycle events to the federation bus.
 *
 * Wires the godmode ChangeSet engine to publish lifecycle events
 * (proposed, simulated, approved, executed, failed, reverted, rolled_back)
 * to the `brainstorm.events` EventBridge bus (BrainstormOps PR #76).
 *
 * Architectural choice: this module defines a thin `ChangeSetEventEmitter`
 * INTERFACE, not a direct EventBridge client. Reasons:
 *
 * 1. godmode runs in multiple contexts (CLI, desktop, server,
 *    sleep-time agents). Not all have AWS credentials — bundling
 *    @aws-sdk/client-eventbridge here would either force every
 *    consumer to pull the SDK or fail at runtime for non-AWS contexts.
 *
 * 2. Tests need a deterministic no-op (or in-memory capture)
 *    emitter. The interface is trivially mockable.
 *
 * 3. The actual EventBridge wiring lives where credentials + region
 *    config live: at the CLI bootstrap or server startup. Those
 *    construct an emitter and inject it via `setChangeSetEventEmitter`.
 *
 * Failure mode: all `emit()` calls are best-effort. Errors are caught,
 * logged at warn level, and never propagate to the caller — a broken
 * federation bus must NOT break ChangeSet execution. The trade-off:
 * we may silently lose events under degraded bus conditions. The
 * replay archive on the bus (BrainstormOps PR #76 §archive) is the
 * recovery path for any losses.
 *
 * Authored as opus PR 7. Composes with:
 *   - packages/changeset-contract (PR #367) — type for the event payload
 *   - BrainstormOps PR #76 — the bus this targets
 *   - BrainstormOps PR #80 — workflow.* schemas (parallel surface)
 */

import { createLogger } from "@brainst0rm/shared";
import type { ChangeSetLifecycleEvent } from "@brainst0rm/changeset-contract";

const log = createLogger("godmode-event-emitter");

export interface ChangeSetEventEmitter {
  /**
   * Publish a ChangeSet lifecycle event. The implementation decides
   * how (EventBridge PutEvents, in-memory queue, no-op, etc.).
   * Errors must be handled internally — this engine treats emission
   * as best-effort. Throwing escapes safety nets and CAN affect
   * ChangeSet execution flow if not caught upstream.
   */
  emit(event: ChangeSetLifecycleEvent): Promise<void> | void;
}

let emitter: ChangeSetEventEmitter | null = null;

/**
 * Wire the global ChangeSet event emitter. Typically called once at
 * application startup. Passing null disables emission (useful in tests).
 */
export function setChangeSetEventEmitter(
  e: ChangeSetEventEmitter | null,
): void {
  emitter = e;
}

/**
 * Internal: invoked by the changeset engine at every lifecycle
 * transition. Best-effort — failures are logged but never propagated.
 */
export function emitChangeSetEvent(event: ChangeSetLifecycleEvent): void {
  if (!emitter) {
    // No emitter wired — emission is opt-in. This is the default for
    // CLI dev sessions, tests, and contexts without federation config.
    return;
  }

  try {
    const result = emitter.emit(event);
    if (result && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).catch((err) => {
        log.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            changeset_id: event.changesetId,
            state: event.payload.state,
          },
          "ChangeSet event emission failed (async, non-fatal)",
        );
      });
    }
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        changeset_id: event.changesetId,
        state: event.payload.state,
      },
      "ChangeSet event emission failed (sync, non-fatal)",
    );
  }
}

/**
 * Test helper: in-memory event capture. Records all emitted events
 * into a local array for assertions. Returns a `clear()` to reset.
 *
 * Usage:
 *   const capture = createTestEmitter();
 *   setChangeSetEventEmitter(capture);
 *   // ... exercise code ...
 *   expect(capture.events).toHaveLength(2);
 *   expect(capture.events[0].payload.state).toBe("proposed");
 *
 * Not for production use.
 */
export interface TestEmitter extends ChangeSetEventEmitter {
  events: ChangeSetLifecycleEvent[];
  clear(): void;
}

export function createTestEmitter(): TestEmitter {
  const events: ChangeSetLifecycleEvent[] = [];
  return {
    emit(event) {
      events.push(event);
    },
    events,
    clear() {
      events.length = 0;
    },
  };
}
