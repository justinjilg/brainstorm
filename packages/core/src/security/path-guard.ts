import { resolve, relative } from 'node:path';
import { realpathSync, existsSync } from 'node:fs';

/**
 * Path Safety Guard — prevents path traversal attacks.
 *
 * All file operations must go through resolveSafe() which validates
 * that the resolved path is within the project directory.
 * Prevents: ../../etc/passwd, symlink escapes, absolute path bypasses.
 */

/**
 * Resolve a path safely within the project directory.
 * Throws if the resolved path escapes the workspace root.
 *
 * Security: resolves symlinks via realpathSync to prevent symlink-based escapes.
 * Also blocks explicit '..' segments in the path.
 */
export function resolveSafe(filePath: string, workspaceRoot: string): string {
  // Block explicit '..' segments before resolution
  const segments = filePath.split(/[/\\]/);
  if (segments.includes('..')) {
    throw new PathTraversalError(filePath, workspaceRoot);
  }

  const resolved = resolve(workspaceRoot, filePath);

  // Resolve symlinks if the file exists (prevents symlink-based escapes)
  const realResolved = existsSync(resolved) ? realpathSync(resolved) : resolved;
  const realWorkspace = existsSync(workspaceRoot) ? realpathSync(workspaceRoot) : resolve(workspaceRoot);

  const rel = relative(realWorkspace, realResolved);

  // Check for path traversal (relative path starts with .. or is absolute)
  if (rel.startsWith('..') || rel.startsWith('/')) {
    throw new PathTraversalError(filePath, workspaceRoot);
  }

  return resolved;
}

/**
 * Check if a path is within the workspace (non-throwing version).
 */
export function isWithinWorkspace(filePath: string, workspaceRoot: string): boolean {
  try {
    resolveSafe(filePath, workspaceRoot);
    return true;
  } catch {
    return false;
  }
}

export class PathTraversalError extends Error {
  constructor(
    public readonly attemptedPath: string,
    public readonly workspaceRoot: string,
  ) {
    super(`Path traversal blocked: "${attemptedPath}" escapes workspace "${workspaceRoot}"`);
    this.name = 'PathTraversalError';
  }
}
