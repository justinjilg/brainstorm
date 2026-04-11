/**
 * Workspace context — AsyncLocalStorage-backed "current project root" for tool
 * path resolution.
 *
 * Why this exists: file_write, file_edit, and similar path-based tools used to
 * resolve relative paths via `process.cwd()`. That meant when a subagent was
 * spawned with a different `projectPath` (e.g., a cloned repo at /tmp/xxx),
 * tool calls would write to the parent CLI's cwd instead of the subagent's
 * project. SWE-bench runs surfaced this: the agent thought it was editing
 * `astropy/modeling/separable.py` in the cloned repo, but the write landed in
 * the brainstorm repo's root.
 *
 * Fix: subagent.ts wraps its streamText execution in withWorkspace(projectPath,
 * async () => { ... }). Path-based tools call getWorkspace() to get the
 * effective root and fall back to process.cwd() when no context is set.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const workspaceStorage = new AsyncLocalStorage<string>();

/**
 * Run a function with a specific workspace root. Tools called inside the
 * callback (including nested async work) can retrieve this via getWorkspace().
 */
export function withWorkspace<T>(
  workspace: string,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  return workspaceStorage.run(workspace, fn);
}

/**
 * Enter a workspace context WITHOUT a callback wrapper. Sets the store for
 * the current async execution and all nested async work — no unset until
 * the async context exits. Use this inside generators where you can't wrap
 * yield statements in a callback.
 *
 * Calls to enterWorkspace in nested async contexts will override for that
 * scope only, restoring the outer workspace when the inner scope exits.
 */
export function enterWorkspace(workspace: string): void {
  workspaceStorage.enterWith(workspace);
}

/**
 * Get the current workspace root. Returns process.cwd() when no context is
 * active — preserving the old behavior for direct CLI usage.
 */
export function getWorkspace(): string {
  return workspaceStorage.getStore() ?? process.cwd();
}
