/**
 * Session context — AsyncLocalStorage-backed "current session id" for
 * session-scoped tool state (tasks, transactions, checkpoints).
 *
 * Why this exists: several tool stores were module-global (one `tasks` Map, one
 * `transactionActive` flag, one `activeCheckpoint`). Two concurrent runs — a
 * server request and a Slack message, or two subagents — would collide on IDs,
 * clear each other's tasks, and cross-wire event handlers. Keying that state by
 * the current session id isolates concurrent runs.
 *
 * Mirrors workspace-context.ts. Tool execution runs inside a session scope
 * entered by the agent loop; stores call getSessionId() to pick their slice.
 * A default id keeps standalone/test usage working without ceremony.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Session id used when no session context is active (standalone/tests). */
export const DEFAULT_SESSION_ID = "__default__";

const sessionStorage = new AsyncLocalStorage<string>();

/**
 * Run a function within a session scope. Tool calls inside the callback
 * (including nested async work) resolve getSessionId() to this id.
 */
export function withSession<T>(
  sessionId: string,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  return sessionStorage.run(sessionId, fn);
}

/**
 * Enter a session scope WITHOUT a callback wrapper — for generators (the agent
 * loop) that can't wrap their yields in a callback. Nested scopes restore the
 * outer id when they exit.
 */
export function enterSession(sessionId: string): void {
  sessionStorage.enterWith(sessionId);
}

/** Current session id, or the default when no session context is active. */
export function getSessionId(): string {
  return sessionStorage.getStore() ?? DEFAULT_SESSION_ID;
}
