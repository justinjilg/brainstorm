/**
 * Repository Map — lightweight code knowledge graph.
 *
 * Parses project files using regex to extract exports, imports, and symbols.
 * Builds a dependency graph and ranks files by connectivity (simplified PageRank).
 * Injects the top files into the system prompt instead of raw file listings,
 * dramatically reducing token usage.
 *
 * Uses regex parsing (no native addons). For deeper AST analysis,
 * tree-sitter can be added as an optional dependency in the future.
 */

import { execFileSync } from "node:child_process";
import {
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { join, relative, extname, basename } from "node:path";

export interface SymbolSignature {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "const" | "enum";
  signature: string;
  exported: boolean;
}

export interface RepoMapEntry {
  file: string;
  exports: string[];
  imports: string[];
  symbols: string[];
  signatures: SymbolSignature[];
  lineCount: number;
}

export interface RepoMap {
  entries: RepoMapEntry[];
  edges: Array<{ from: string; to: string }>;
  topFiles: string[];
  totalFiles: number;
  generated: number;
}

// In-memory cache with TTL
let _repoMapCache: { path: string; map: RepoMap; ts: number } | null = null;
const REPO_MAP_TTL_MS = 30_000;

// Persistent entry cache keyed by file path → mtime for incremental updates
let _entryCache: Map<string, { mtime: number; entry: RepoMapEntry }> =
  new Map();
let _entryCacheProject: string | null = null;

/**
 * Build a repository map for the given project.
 * Uses incremental updates: only re-parses files whose mtime changed.
 * Results cached in memory (30s TTL) and entries cached by mtime.
 *
 * @param projectPath - Root directory of the project
 * @param maxFiles - Maximum number of top files to include (default: 15)
 */
export function buildRepoMap(projectPath: string, maxFiles = 15): RepoMap {
  if (
    _repoMapCache &&
    _repoMapCache.path === projectPath &&
    Date.now() - _repoMapCache.ts < REPO_MAP_TTL_MS
  ) {
    return _repoMapCache.map;
  }

  // Reset entry cache if project changed
  if (_entryCacheProject !== projectPath) {
    _entryCache = new Map();
    _entryCacheProject = projectPath;
  }

  const files = findSourceFiles(projectPath);
  const entries: RepoMapEntry[] = [];

  for (const file of files) {
    try {
      const fullPath = join(projectPath, file);
      const mtime = statSync(fullPath).mtimeMs;
      const cached = _entryCache.get(file);

      if (cached && cached.mtime === mtime) {
        entries.push(cached.entry);
      } else {
        const content = readFileSync(fullPath, "utf-8");
        const entry = parseFile(file, content);
        entries.push(entry);
        _entryCache.set(file, { mtime, entry });
      }
    } catch {
      // Skip unreadable files
    }
  }

  // Clean stale entries from cache
  const fileSet = new Set(files);
  for (const key of _entryCache.keys()) {
    if (!fileSet.has(key)) _entryCache.delete(key);
  }

  const edges = buildEdges(entries);
  const ranked = rankFiles(entries, edges);
  const topFiles = ranked.slice(0, maxFiles);

  const map: RepoMap = {
    entries,
    edges,
    topFiles,
    totalFiles: files.length,
    generated: Date.now(),
  };

  _repoMapCache = { path: projectPath, map, ts: Date.now() };
  return map;
}

/**
 * Format the repo map as a compact context string for system prompt injection.
 */
export function repoMapToContext(map: RepoMap): string {
  if (map.topFiles.length === 0) return "";

  const lines = [
    `Project structure (${map.topFiles.length} key files of ${map.totalFiles}):`,
  ];

  for (const file of map.topFiles) {
    const entry = map.entries.find((e) => e.file === file);
    if (!entry) continue;

    const exports =
      entry.exports.length > 0
        ? `: exports ${entry.exports.slice(0, 5).join(", ")}${entry.exports.length > 5 ? ` (+${entry.exports.length - 5} more)` : ""}`
        : "";
    lines.push(`  ${entry.file}${exports} (${entry.lineCount} lines)`);
  }

  return lines.join("\n");
}

/**
 * Find all source files in the project (TypeScript, JavaScript, Python).
 * Excludes node_modules, dist, .next, .git, etc.
 */
function findSourceFiles(projectPath: string): string[] {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      {
        cwd: projectPath,
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const sourceExtensions = new Set([
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".py",
      ".go",
      ".rs",
    ]);
    const excludeDirs = [
      "node_modules",
      "dist",
      ".next",
      ".git",
      "build",
      "coverage",
      "__pycache__",
    ];

    return output
      .trim()
      .split("\n")
      .filter((f) => {
        if (!f) return false;
        const ext = extname(f);
        if (!sourceExtensions.has(ext)) return false;
        // Exclude declaration files
        if (f.endsWith(".d.ts")) return false;
        // Exclude common non-source directories
        return !excludeDirs.some(
          (d) => f.startsWith(d + "/") || f.includes("/" + d + "/"),
        );
      });
  } catch {
    return [];
  }
}

/**
 * Parse a source file using regex to extract exports, imports, and symbols.
 */
function parseFile(filePath: string, content: string): RepoMapEntry {
  const exports: string[] = [];
  const imports: string[] = [];
  const symbols: string[] = [];
  const signatures: SymbolSignature[] = [];

  const ext = extname(filePath);

  if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
    parseTypeScript(content, exports, imports, symbols);
    extractTypeScriptSignatures(content, signatures);
  } else if (ext === ".py") {
    parsePython(content, exports, imports, symbols);
    extractPythonSignatures(content, signatures);
  }

  return {
    file: filePath,
    exports: [...new Set(exports)],
    imports: [...new Set(imports)],
    symbols: [...new Set(symbols)],
    signatures,
    lineCount: content.split("\n").length,
  };
}

function parseTypeScript(
  content: string,
  exports: string[],
  imports: string[],
  symbols: string[],
): void {
  // Export declarations
  const exportMatches = content.matchAll(
    /export\s+(?:default\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g,
  );
  for (const m of exportMatches) {
    exports.push(m[1]);
    symbols.push(m[1]);
  }

  // Re-exports: export { Foo, Bar } from './module'
  const reExportMatches = content.matchAll(/export\s*\{([^}]+)\}/g);
  for (const m of reExportMatches) {
    const names = m[1]
      .split(",")
      .map((n) =>
        n
          .trim()
          .split(/\s+as\s+/)
          .pop()
          ?.trim(),
      )
      .filter(Boolean);
    exports.push(...(names as string[]));
  }

  // Import declarations
  const importMatches = content.matchAll(
    /import\s+.*?from\s+['"]([^'"]+)['"]/g,
  );
  for (const m of importMatches) {
    imports.push(m[1]);
  }

  // Non-exported functions and classes
  const symbolMatches = content.matchAll(/(?:function|class)\s+(\w+)/g);
  for (const m of symbolMatches) {
    symbols.push(m[1]);
  }
}

function parsePython(
  content: string,
  exports: string[],
  imports: string[],
  symbols: string[],
): void {
  // Def/class at module level (no indent)
  const defMatches = content.matchAll(/^(?:def|class)\s+(\w+)/gm);
  for (const m of defMatches) {
    exports.push(m[1]);
    symbols.push(m[1]);
  }

  // Import statements
  const importMatches = content.matchAll(
    /(?:from\s+(\S+)\s+import|import\s+(\S+))/g,
  );
  for (const m of importMatches) {
    imports.push(m[1] ?? m[2]);
  }
}

/**
 * Extract function/class/interface/type signatures from TypeScript content.
 */
function extractTypeScriptSignatures(
  content: string,
  signatures: SymbolSignature[],
): void {
  // Exported function signatures: capture up to the opening brace or return type
  const exportedFnRe =
    /export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*(<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^\n{]+))?/g;
  for (const m of content.matchAll(exportedFnRe)) {
    const generics = m[2] ?? "";
    const params = m[3].trim();
    const returnType = m[4]?.trim() ?? "void";
    signatures.push({
      name: m[1],
      kind: "function",
      signature: `function ${m[1]}${generics}(${params}): ${returnType}`,
      exported: true,
    });
  }

  // Non-exported function signatures
  const fnRe =
    /^(?!export)(?:async\s+)?function\s+(\w+)\s*(<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^\n{]+))?/gm;
  for (const m of content.matchAll(fnRe)) {
    const generics = m[2] ?? "";
    const params = m[3].trim();
    const returnType = m[4]?.trim() ?? "void";
    signatures.push({
      name: m[1],
      kind: "function",
      signature: `function ${m[1]}${generics}(${params}): ${returnType}`,
      exported: false,
    });
  }

  // Exported class declarations
  const classRe =
    /export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([^\n{]+))?/g;
  for (const m of content.matchAll(classRe)) {
    let sig = `class ${m[1]}`;
    if (m[2]) sig += ` extends ${m[2].trim()}`;
    if (m[3]) sig += ` implements ${m[3].trim()}`;
    signatures.push({
      name: m[1],
      kind: "class",
      signature: sig,
      exported: true,
    });
  }

  // Exported interface declarations
  const ifaceRe =
    /export\s+(?:default\s+)?interface\s+(\w+)(?:\s+extends\s+([^\n{]+))?/g;
  for (const m of content.matchAll(ifaceRe)) {
    let sig = `interface ${m[1]}`;
    if (m[2]) sig += ` extends ${m[2].trim()}`;
    signatures.push({
      name: m[1],
      kind: "interface",
      signature: sig,
      exported: true,
    });
  }

  // Exported type aliases
  const typeRe = /export\s+type\s+(\w+)(?:<[^>]*>)?\s*=/g;
  for (const m of content.matchAll(typeRe)) {
    signatures.push({
      name: m[1],
      kind: "type",
      signature: `type ${m[1]}`,
      exported: true,
    });
  }

  // Exported enums
  const enumRe = /export\s+(?:const\s+)?enum\s+(\w+)/g;
  for (const m of content.matchAll(enumRe)) {
    signatures.push({
      name: m[1],
      kind: "enum",
      signature: `enum ${m[1]}`,
      exported: true,
    });
  }

  // Exported const (arrow functions and values)
  const constRe = /export\s+const\s+(\w+)(?:\s*:\s*([^\n=]+))?\s*=/g;
  for (const m of content.matchAll(constRe)) {
    const typeAnnotation = m[2]?.trim();
    signatures.push({
      name: m[1],
      kind: "const",
      signature: typeAnnotation
        ? `const ${m[1]}: ${typeAnnotation}`
        : `const ${m[1]}`,
      exported: true,
    });
  }
}

/**
 * Extract function/class signatures from Python content.
 */
function extractPythonSignatures(
  content: string,
  signatures: SymbolSignature[],
): void {
  // Module-level def (no indent)
  const defRe = /^def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*(\S+))?/gm;
  for (const m of content.matchAll(defRe)) {
    const returnType = m[3] ?? "None";
    signatures.push({
      name: m[1],
      kind: "function",
      signature: `def ${m[1]}(${m[2].trim()}) -> ${returnType}`,
      exported: !m[1].startsWith("_"),
    });
  }

  // Module-level class
  const classRe = /^class\s+(\w+)(?:\(([^)]*)\))?/gm;
  for (const m of content.matchAll(classRe)) {
    const bases = m[2]?.trim();
    const sig = bases ? `class ${m[1]}(${bases})` : `class ${m[1]}`;
    signatures.push({
      name: m[1],
      kind: "class",
      signature: sig,
      exported: !m[1].startsWith("_"),
    });
  }
}

/**
 * Generate a structured repo map string suitable for system prompt injection.
 *
 * Includes function/class signatures, export lists per file, and import relationships.
 * This is the primary entry point for the agent context builder.
 *
 * @param projectPath - Root directory of the project
 * @param maxFiles - Maximum number of top files to include (default: 20)
 */
export function generateRepoMap(projectPath: string, maxFiles = 20): string {
  const map = buildRepoMap(projectPath, maxFiles);
  if (map.topFiles.length === 0) return "";

  const lines: string[] = [
    `# Repository Map (${map.topFiles.length} key files of ${map.totalFiles} total)`,
    "",
  ];

  for (const file of map.topFiles) {
    const entry = map.entries.find((e) => e.file === file);
    if (!entry) continue;

    lines.push(`## ${entry.file} (${entry.lineCount} lines)`);

    // Export list
    if (entry.exports.length > 0) {
      const exportList =
        entry.exports.length <= 8
          ? entry.exports.join(", ")
          : entry.exports.slice(0, 8).join(", ") +
            ` (+${entry.exports.length - 8} more)`;
      lines.push(`  Exports: ${exportList}`);
    }

    // Signatures (only exported ones, limit to 10)
    const exportedSigs = entry.signatures.filter((s) => s.exported);
    if (exportedSigs.length > 0) {
      const sigsToShow = exportedSigs.slice(0, 10);
      for (const sig of sigsToShow) {
        lines.push(`  - ${sig.signature}`);
      }
      if (exportedSigs.length > 10) {
        lines.push(`  ... +${exportedSigs.length - 10} more signatures`);
      }
    }

    // Import relationships (local imports only, skip node_modules)
    const localImports = entry.imports.filter(
      (imp) => imp.startsWith(".") || imp.startsWith("@brainstorm/"),
    );
    if (localImports.length > 0) {
      const importList =
        localImports.length <= 6
          ? localImports.join(", ")
          : localImports.slice(0, 6).join(", ") +
            ` (+${localImports.length - 6} more)`;
      lines.push(`  Imports: ${importList}`);
    }

    lines.push("");
  }

  // Import relationship summary (top edges)
  const edgeSummary = buildImportSummary(map);
  if (edgeSummary.length > 0) {
    lines.push("## Import Graph (most connected)");
    for (const line of edgeSummary) {
      lines.push(`  ${line}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Build a compact summary of the most important import relationships.
 */
function buildImportSummary(map: RepoMap): string[] {
  // Count incoming edges per file
  const inDegree = new Map<string, number>();
  for (const edge of map.edges) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  // Sort by incoming edges descending, take top 5
  const sorted = [...inDegree.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return sorted.map(
    ([file, count]) =>
      `${file} <- imported by ${count} file${count > 1 ? "s" : ""}`,
  );
}

/**
 * Build dependency edges from import statements.
 */
function buildEdges(
  entries: RepoMapEntry[],
): Array<{ from: string; to: string }> {
  const edges: Array<{ from: string; to: string }> = [];
  const fileMap = new Map<string, string>();

  // Build a map of base names and relative paths to file paths
  for (const entry of entries) {
    const base = basename(entry.file, extname(entry.file));
    fileMap.set(base, entry.file);
    fileMap.set(entry.file, entry.file);
  }

  for (const entry of entries) {
    for (const imp of entry.imports) {
      // Try to resolve import to a known file
      const importBase = basename(
        imp.replace(/\.js$/, "").replace(/\.ts$/, ""),
      );
      const target = fileMap.get(importBase);
      if (target && target !== entry.file) {
        edges.push({ from: entry.file, to: target });
      }
    }
  }

  return edges;
}

/**
 * Rank files by connectivity (simplified PageRank).
 * Files that are imported by many other files rank higher.
 */
function rankFiles(
  entries: RepoMapEntry[],
  edges: Array<{ from: string; to: string }>,
): string[] {
  const scores = new Map<string, number>();

  // Initialize all files with score 1
  for (const entry of entries) {
    scores.set(entry.file, 1);
  }

  // Add 1 point for each incoming edge (file is imported by another)
  for (const edge of edges) {
    scores.set(edge.to, (scores.get(edge.to) ?? 0) + 1);
  }

  // Boost index files (they're usually important entry points)
  for (const entry of entries) {
    if (basename(entry.file).startsWith("index.")) {
      scores.set(entry.file, (scores.get(entry.file) ?? 0) + 2);
    }
  }

  // Boost files with many exports (they're likely important)
  for (const entry of entries) {
    if (entry.exports.length > 5) {
      scores.set(entry.file, (scores.get(entry.file) ?? 0) + 1);
    }
  }

  // Sort by score descending
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([file]) => file);
}
