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
 * loop) that can't wrap their yields in a callback.
 *
 * CAUTION: `enterWith` sets the store for the current async execution and all
 * nested continuations; it does NOT restore the previous id when this scope
 * "exits" (there is no exit — it persists on the current async resource). A
 * consumer that drives a generator via `enterSession` then continues doing
 * other work in the SAME async context will keep this session id. When callers
 * may share an async context across sessions, prefer `withSession(...)` (which
 * scopes to a callback and restores) over `enterSession`.
 */
export function enterSession(sessionId: string): void {
  sessionStorage.enterWith(sessionId);
}

/** Current session id, or the default when no session context is active. */
export function getSessionId(): string {
  return sessionStorage.getStore() ?? DEFAULT_SESSION_ID;
}
