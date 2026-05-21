/**
 * @brainst0rm/eventbridge-binding
 *
 * Wires `@brainst0rm/godmode`'s ChangeSetEventEmitter interface (defined
 * in opus PR #372) to the actual AWS EventBridge bus
 * `brainstorm.events` (BrainstormOps PR #76). Consumers (CLI, server)
 * call `installEventBridgeEmitter(config)` at bootstrap; from then on,
 * every ChangeSet lifecycle transition publishes to the bus.
 *
 * Separated from godmode so non-AWS consumers (e.g. dev sessions
 * without AWS credentials) don't pull @aws-sdk/client-eventbridge.
 *
 * Authored as opus PR 7.1. Composes with:
 *   - PR #367 (changeset-contract): provides the event types
 *   - PR #372 (event emission interface in godmode): provides the slot
 *   - BrainstormOps PR #76 (eventbridge-bus): the target bus + schemas
 */

import {
  EventBridgeClient,
  PutEventsCommand,
  type PutEventsRequestEntry,
} from "@aws-sdk/client-eventbridge";
import { createLogger } from "@brainst0rm/shared";
import type { ChangeSetEventEmitter } from "@brainst0rm/godmode";
import { setChangeSetEventEmitter } from "@brainst0rm/godmode";
import type { ChangeSetLifecycleEvent } from "@brainst0rm/changeset-contract";

const log = createLogger("eventbridge-binding");

export interface EventBridgeEmitterConfig {
  /** AWS region where the bus lives. Defaults to us-east-1. */
  region?: string;
  /** EventBridge bus name. Defaults to "brainstorm.events". */
  busName?: string;
  /**
   * Optional EventBridgeClient instance. Useful for tests + for
   * consumers that already have a credential-managed client. If absent,
   * a fresh client is created with the SDK's default credential chain.
   */
  client?: EventBridgeClient;
}

const DEFAULT_REGION = "us-east-1";
const DEFAULT_BUS_NAME = "brainstorm.events";

/**
 * State-name translation: the godmode engine uses ChangeSetStatus values
 * (draft / approved / executed / failed / rolled_back / rejected /
 * expired). The EventBridge schemas in BrainstormOps PR #76 use the
 * narrative-aligned names (proposed / simulated / approved / executed /
 * failed / reverted). This map bridges them at the wire layer.
 */
function statusToWireState(state: string): string {
  switch (state) {
    case "draft":
      return "proposed";
    case "rolled_back":
      return "reverted";
    case "rejected":
      return "reverted";
    // "approved", "executed", "failed", "expired" pass through unchanged
    default:
      return state;
  }
}

/**
 * Construct (but don't install) an EventBridge-backed
 * ChangeSetEventEmitter. Useful when the caller wants to manage the
 * emitter lifecycle directly.
 */
export function createEventBridgeChangeSetEmitter(
  config: EventBridgeEmitterConfig = {},
): ChangeSetEventEmitter {
  const region = config.region ?? DEFAULT_REGION;
  const busName = config.busName ?? DEFAULT_BUS_NAME;
  const client = config.client ?? new EventBridgeClient({ region });

  return {
    async emit(event: ChangeSetLifecycleEvent): Promise<void> {
      const wireState = statusToWireState(event.payload.state);
      const detail = {
        ...event,
        payload: {
          ...event.payload,
          state: wireState,
        },
      };

      const entry: PutEventsRequestEntry = {
        Source: `brainstorm.${event.payload.product}`,
        DetailType: `changeset.${wireState}`,
        Detail: JSON.stringify(detail),
        EventBusName: busName,
      };

      const result = await client.send(
        new PutEventsCommand({ Entries: [entry] }),
      );

      // EventBridge returns 200 even on per-entry failures — check
      // FailedEntryCount + Entries[].ErrorCode to detect.
      if (result.FailedEntryCount && result.FailedEntryCount > 0) {
        const errors = (result.Entries ?? [])
          .filter((e) => e.ErrorCode)
          .map((e) => `${e.ErrorCode}: ${e.ErrorMessage}`)
          .join("; ");
        // Throw so godmode's outer best-effort catch logs at warn level.
        // We don't want to silently lose events when EB rejects them
        // (schema mismatch, bus doesn't exist, permission denied, etc.).
        throw new Error(`EventBridge PutEvents partial failure: ${errors}`);
      }
    },
  };
}

/**
 * Wire the EventBridge emitter as the global ChangeSet event sink.
 * Idempotent — calling twice replaces the previous emitter. Pass
 * `null` config to disable (replace with no-op).
 *
 * Typical usage in CLI/server bootstrap:
 *
 *   import { installEventBridgeEmitter } from "@brainst0rm/eventbridge-binding";
 *
 *   if (process.env.BRAINSTORM_EVENTBRIDGE_ENABLED === "1") {
 *     installEventBridgeEmitter({
 *       region: process.env.AWS_REGION,
 *       busName: process.env.BRAINSTORM_EVENT_BUS_NAME,
 *     });
 *   }
 */
export function installEventBridgeEmitter(
  config: EventBridgeEmitterConfig = {},
): ChangeSetEventEmitter {
  const emitter = createEventBridgeChangeSetEmitter(config);
  setChangeSetEventEmitter(emitter);
  log.info(
    {
      bus: config.busName ?? DEFAULT_BUS_NAME,
      region: config.region ?? DEFAULT_REGION,
    },
    "EventBridge ChangeSet emitter installed",
  );
  return emitter;
}

/**
 * Convenience: uninstall the emitter (replace with no-op). Useful in
 * tests + during graceful shutdown.
 */
export function uninstallEventBridgeEmitter(): void {
  setChangeSetEventEmitter(null);
}

// Re-export the wire-state translation so consumers can use it
// independently (e.g. when constructing events from outside the engine).
export { statusToWireState };
