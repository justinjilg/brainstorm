/**
 * Community Namer — auto-generates descriptive names for code communities.
 *
 * Strategy: find the most common directory prefix and the most frequent
 * function name stems. Combines them into a readable sector name.
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
  // Extract directory paths
  const dirCounts = new Map<string, number>();
  for (const m of members) {
    const parts = m.file.split("/");
    // Use the last 2 directory segments for specificity
    for (let i = Math.max(0, parts.length - 3); i < parts.length - 1; i++) {
      const dir = parts[i];
      if (dir && !isSkippableDir(dir)) {
        dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
      }
    }
  }

  // Find dominant directory
  let dominantDir = "";
  let maxDirCount = 0;
  for (const [dir, count] of dirCounts) {
    if (count > maxDirCount) {
      maxDirCount = count;
      dominantDir = dir;
    }
  }

  // Extract function name stems (camelCase/snake_case split)
  const stemCounts = new Map<string, number>();
  for (const m of members) {
    if (m.kind === "function" || m.kind === "method") {
      const stems = extractStems(m.name);
      for (const stem of stems) {
        stemCounts.set(stem, (stemCounts.get(stem) ?? 0) + 1);
      }
    }
  }

  // Find top 2 stems
  const topStems = [...stemCounts.entries()]
    .filter(([stem]) => stem.length > 2 && !isCommonStem(stem))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([stem]) => stem);

  // Build name
  const parts: string[] = [];
  if (dominantDir) parts.push(dominantDir);
  if (topStems.length > 0) parts.push(topStems.join("-"));

  if (parts.length === 0) {
    // Fallback: use the most common file name
    const fileCounts = new Map<string, number>();
    for (const m of members) {
      const fileName =
        m.file
          .split("/")
          .pop()
          ?.replace(/\.[^.]+$/, "") ?? "";
      if (fileName)
        fileCounts.set(fileName, (fileCounts.get(fileName) ?? 0) + 1);
    }
    const topFile = [...fileCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    return topFile ? topFile[0] : `sector-${members.length}`;
  }

  return parts.join("/");
}

function extractStems(name: string): string[] {
  // Split camelCase: handleRequest → [handle, request]
  // Split snake_case: handle_request → [handle, request]
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_\-.]/)
    .filter((s) => s.length > 2);
}

function isSkippableDir(dir: string): boolean {
  return ["src", "lib", "app", "apps", "packages", "internal", "pkg"].includes(
    dir,
  );
}

function isCommonStem(stem: string): boolean {
  return [
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
  ].includes(stem);
}
