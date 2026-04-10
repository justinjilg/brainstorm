/**
 * Dependency Graph Builder — maps imports and exports across the codebase.
 *
 * Builds a directed graph of which files import which other files.
 * Used for: understanding module boundaries, detecting dead code,
 * identifying high-coupling modules, generating architecture diagrams.
 *
 * Flywheel: dependency graph → auto-generated .agent.md per module cluster.
 * Each agent gets domain-specific context → better outcomes → better routing.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, relative, dirname, resolve } from "node:path";

export interface DependencyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: ModuleCluster[];
  entryPoints: string[];
  leafNodes: string[];
}

export interface GraphNode {
  path: string;
  language: string;
  lines: number;
  exports: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
  importType: "static" | "dynamic" | "require";
}

export interface ModuleCluster {
  directory: string;
  files: string[];
  internalEdges: number;
  externalEdges: number;
  cohesion: number;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".gradle",
  "vendor",
]);

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".rb",
  ".php",
]);

const IMPORT_PATTERNS = {
  typescript: [
    /import\s+(?:(?:type\s+)?(?:\{[^}]*\}|[\w*]+)(?:\s*,\s*(?:\{[^}]*\}|[\w*]+))*\s+from\s+)?['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ],
  python: [/^from\s+([\w.]+)\s+import/gm, /^import\s+([\w.]+)/gm],
};

export function buildDependencyGraph(projectPath: string): DependencyGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const files = collectCodeFiles(projectPath);

  for (const filePath of files) {
    const rel = relative(projectPath, filePath);
    const ext = extname(filePath).toLowerCase();
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const lines = content.split("\n").filter((l) => l.trim().length > 0).length;
    const exports = extractExports(content, ext);
    nodes.push({ path: rel, language: extToLang(ext), lines, exports });

    const imports = extractImports(content, ext);
    for (const imp of imports) {
      const resolved = resolveImport(imp.specifier, filePath);
      if (resolved) {
        edges.push({
          from: rel,
          to: relative(projectPath, resolved),
          importType: imp.type,
        });
      }
    }
  }

  const clusters = buildClusters(nodes, edges);
  const importedFiles = new Set(edges.map((e) => e.to));
  const importingFiles = new Set(edges.map((e) => e.from));

  return {
    nodes,
    edges,
    clusters,
    entryPoints: nodes
      .filter((n) => !importedFiles.has(n.path))
      .map((n) => n.path),
    leafNodes: nodes
      .filter((n) => !importingFiles.has(n.path))
      .map((n) => n.path),
  };
}

function collectCodeFiles(dir: string, maxDepth = 10): string[] {
  const files: string[] = [];
  function walk(d: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(d, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full, depth + 1);
      else if (CODE_EXTENSIONS.has(extname(entry).toLowerCase()))
        files.push(full);
    }
  }
  walk(dir, 0);
  return files;
}

export function extractImports(
  content: string,
  ext: string,
): Array<{ specifier: string; type: "static" | "dynamic" | "require" }> {
  const results: Array<{
    specifier: string;
    type: "static" | "dynamic" | "require";
  }> = [];
  const lang = ext === ".py" ? "python" : "typescript";
  const patterns = IMPORT_PATTERNS[lang] ?? IMPORT_PATTERNS.typescript;

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const spec = match[1];
      if (!spec || spec.startsWith("node:")) continue;
      const type = pattern.source.includes("require")
        ? ("require" as const)
        : pattern.source.includes("import\\s*\\(")
          ? ("dynamic" as const)
          : ("static" as const);
      results.push({ specifier: spec, type });
    }
  }
  return results;
}

export function extractExports(content: string, ext: string): string[] {
  const exports: string[] = [];
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs"].includes(ext)) {
    for (const m of content.matchAll(
      /export\s+(?:default\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g,
    )) {
      if (m[1]) exports.push(m[1]);
    }
  }
  if (ext === ".py") {
    for (const m of content.matchAll(/^(?:def|class)\s+(\w+)/gm)) {
      if (m[1] && !m[1].startsWith("_")) exports.push(m[1]);
    }
  }
  return exports;
}

function resolveImport(specifier: string, fromFile: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const dir = dirname(fromFile);
  const resolved = resolve(dir, specifier);
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".py"];
  for (const ext of extensions) {
    const p = resolved.endsWith(ext) ? resolved : resolved + ext;
    try {
      statSync(p);
      return p;
    } catch {
      /* */
    }
  }
  for (const ext of extensions) {
    try {
      statSync(join(resolved, `index${ext}`));
      return join(resolved, `index${ext}`);
    } catch {
      /* */
    }
  }
  return null;
}

function buildClusters(
  nodes: GraphNode[],
  edges: GraphEdge[],
): ModuleCluster[] {
  const dirFiles = new Map<string, string[]>();
  for (const node of nodes) {
    const dir = dirname(node.path);
    const files = dirFiles.get(dir) ?? [];
    files.push(node.path);
    dirFiles.set(dir, files);
  }

  const clusters: ModuleCluster[] = [];
  for (const [dir, files] of dirFiles) {
    if (files.length < 2) continue;
    const fileSet = new Set(files);
    let internal = 0,
      external = 0;
    for (const edge of edges) {
      if (fileSet.has(edge.from)) {
        if (fileSet.has(edge.to)) internal++;
        else external++;
      }
    }
    const total = internal + external;
    clusters.push({
      directory: dir,
      files,
      internalEdges: internal,
      externalEdges: external,
      cohesion: total > 0 ? Math.round((internal / total) * 100) / 100 : 0,
    });
  }
  return clusters.sort((a, b) => b.files.length - a.files.length);
}

function extToLang(ext: string): string {
  const map: Record<string, string> = {
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".py": "Python",
    ".rs": "Rust",
    ".go": "Go",
    ".java": "Java",
    ".rb": "Ruby",
    ".php": "PHP",
  };
  return map[ext] ?? "Unknown";
}
