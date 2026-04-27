// ACK-timeout manager per protocol-v1 §5.1.5 + V3-ACK-01 fix.
//
// Timer starts at relay-side `successful_ws_write` of CommandEnvelope, not
// at endpoint receipt (which relay cannot observe). 5s default.
//
// On expiry, fires the registered onTimeout callback with the command_id.
// The callback typically routes to ResultRouter.handleAckTimeout() which
// transitions lifecycle dispatched → timed_out and emits ENDPOINT_NO_ACK.
//
// Designed with injectable timer for testability — tests use fake timers
// rather than real setTimeout.

export interface AckTimeoutManagerOptions {
  /** Default 5000ms per spec. Overridable for tests. */
  timeoutMs?: number;
  /**
   * Timer scheduling primitives. Defaults to global setTimeout/clearTimeout.
   * Tests can inject a fake clock.
   */
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export class AckTimeoutManager {
  private readonly timeoutMs: number;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly active = new Map<string, unknown>();

  constructor(opts: AckTimeoutManagerOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.setTimeoutFn =
      opts.setTimeout ?? ((cb, ms) => setTimeout(cb, ms) as unknown);
    this.clearTimeoutFn =
      opts.clearTimeout ?? ((handle) => clearTimeout(handle as never));
  }

  /**
   * Start the ACK-timeout timer for a command_id. Caller invokes this
   * AT the relay-side successful WS-write of CommandEnvelope (not at
   * dispatch begin). Throws if a timer already exists for this command_id.
   *
   * `onTimeout` is invoked exactly once if the timer fires. Cancel-vs-
   * fire is mutually exclusive.
   */
  start(command_id: string, onTimeout: (command_id: string) => void): void {
    if (this.active.has(command_id)) {
      throw new Error(
        `AckTimeoutManager: timer already active for command_id ${command_id}`,
      );
    }
    const handle = this.setTimeoutFn(() => {
      this.active.delete(command_id);
      onTimeout(command_id);
    }, this.timeoutMs);
    this.active.set(command_id, handle);
  }

  /**
   * Cancel a pending timer. Idempotent — calling cancel for a command_id
   * with no active timer is a no-op (e.g., the timer already fired, or
   * cancel called twice).
   */
  cancel(command_id: string): boolean {
    const handle = this.active.get(command_id);
    if (handle === undefined) {
      return false;
    }
    this.clearTimeoutFn(handle);
    this.active.delete(command_id);
    return true;
  }

  isActive(command_id: string): boolean {
    return this.active.has(command_id);
  }

  count(): number {
    return this.active.size;
  }

  /**
   * Cancel all active timers. Use during relay shutdown.
   */
  cancelAll(): void {
    for (const handle of this.active.values()) {
      this.clearTimeoutFn(handle);
    }
    this.active.clear();
  }
}
