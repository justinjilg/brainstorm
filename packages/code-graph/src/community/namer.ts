/**
 * Community Namer — auto-generates descriptive names for code communities.
 *
 * Strategy:
 * 1. Find the most specific directory path shared by members
 * 2. Extract meaningful function name stems (filter generic words)
 * 3. Combine into a readable label like "providers/bedrock-transform"
 *    or "handlers/cache-service"
 */

interface NodeInfo {
  name: string;
  kind: string;
  file: string;
}

/**
 * Generate a descriptive name for a community from its member nodes.
 */
export function nameCommunity(members: NodeInfo[]): string {
  // Find the most specific shared directory path
  const dirPath = findDominantPath(members);

  // Extract meaningful function name stems
  const stems = findMeaningfulStems(members);

  // Build name
  if (dirPath && stems.length > 0) {
    return `${dirPath}/${stems.join("-")}`;
  }
  if (dirPath) return dirPath;
  if (stems.length > 0) return stems.join("-");

  // Fallback: most common file name
  const fileCounts = new Map<string, number>();
  for (const m of members) {
    const fileName =
      m.file
        .split("/")
        .pop()
        ?.replace(/\.[^.]+$/, "") ?? "";
    if (fileName) fileCounts.set(fileName, (fileCounts.get(fileName) ?? 0) + 1);
  }
  const topFile = [...fileCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  return topFile ? topFile[0] : `sector-${members.length}`;
}

/**
 * Find the most specific directory path shared by members.
 * Prefers "providers/bedrock" over just "providers".
 */
function findDominantPath(members: NodeInfo[]): string {
  // Count full 2-segment paths (more specific than single dirs)
  const pathCounts = new Map<string, number>();

  for (const m of members) {
    const parts = m.file.split("/").filter((p) => p && !isSkippableDir(p));
    // Take the last 2 meaningful segments before the filename
    const meaningful = parts.slice(0, -1); // exclude filename
    if (meaningful.length >= 2) {
      const path = meaningful.slice(-2).join("/");
      pathCounts.set(path, (pathCounts.get(path) ?? 0) + 1);
    } else if (meaningful.length === 1) {
      pathCounts.set(meaningful[0], (pathCounts.get(meaningful[0]) ?? 0) + 1);
    }
  }

  if (pathCounts.size === 0) return "";

  // Pick the most common path
  const sorted = [...pathCounts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted[0][0];
}

/**
 * Extract meaningful stems from function names.
 * Filters out generic verbs and common prefixes.
 */
function findMeaningfulStems(members: NodeInfo[]): string[] {
  const stemCounts = new Map<string, number>();

  for (const m of members) {
    if (m.kind !== "function" && m.kind !== "method") continue;
    const stems = extractStems(m.name);
    for (const stem of stems) {
      if (!isGenericStem(stem)) {
        stemCounts.set(stem, (stemCounts.get(stem) ?? 0) + 1);
      }
    }
  }

  return [...stemCounts.entries()]
    .filter(([stem]) => stem.length > 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([stem]) => stem);
}

function extractStems(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_\-.]/)
    .filter((s) => s.length > 2);
}

function isSkippableDir(dir: string): boolean {
  return [
    "src",
    "lib",
    "app",
    "apps",
    "packages",
    "internal",
    "pkg",
    "dist",
    "build",
    "out",
    "node_modules",
    "__tests__",
    "tests",
    "test",
  ].includes(dir);
}

/**
 * Generic stems that don't add meaning to a sector name.
 * Expanded from the original list to catch more false positives.
 */
function isGenericStem(stem: string): boolean {
  return GENERIC_STEMS.has(stem);
}

const GENERIC_STEMS = new Set([
  // Verbs
  "get",
  "set",
  "new",
  "create",
  "make",
  "init",
  "build",
  "run",
  "start",
  "stop",
  "handle",
  "process",
  "parse",
  "check",
  "test",
  "from",
  "with",
  "the",
  "for",
  "add",
  "remove",
  "update",
  "delete",
  "load",
  "save",
  "read",
  "write",
  "send",
  "receive",
  "return",
  "call",
  "apply",
  "bind",
  "execute",
  "invoke",
  // Generic nouns
  "data",
  "result",
  "response",
  "request",
  "error",
  "event",
  "item",
  "value",
  "index",
  "list",
  "array",
  "object",
  "string",
  "number",
  "type",
  "name",
  "path",
  "file",
  "dir",
  "url",
  "base",
  "config",
  "options",
  "params",
  "args",
  "input",
  "output",
  "state",
  "status",
  "helper",
  "util",
  "utils",
  "misc",
  "common",
  "shared",
  "default",
  "main",
  "app",
  "module",
  "component",
  "service",
  "manager",
]);
