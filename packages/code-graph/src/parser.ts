/**
 * Multi-language parser — dispatches to language-specific adapters.
 *
 * Extracts:
 *   - Function definitions (name, file, line, signature)
 *   - Class definitions (name, file, line, methods)
 *   - Method definitions (name, class, file, line)
 *   - Call sites (caller function, callee name, file, line)
 *   - Imports (file imports module)
 *
 * This is the foundation for the knowledge graph.
 * The actual parsing logic lives in packages/code-graph/src/languages/*.ts
 */

import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { getAdapterForExtension } from "./languages/registry.js";

export interface FunctionDef {
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  signature: string;
  isExported: boolean;
  isAsync: boolean;
}

export interface ClassDef {
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
}

export interface MethodDef {
  name: string;
  className: string;
  file: string;
  startLine: number;
  endLine: number;
  isStatic: boolean;
  isAsync: boolean;
}

export interface CallSite {
  callerName: string | null; // null if at module level
  calleeName: string;
  file: string;
  line: number;
}

export interface ImportDecl {
  file: string;
  source: string; // the imported module path
  names: string[]; // imported names
  isDefault: boolean;
}

export interface ParsedFile {
  file: string;
  contentHash: string;
  /** Language that parsed this file. */
  language?: string;
  functions: FunctionDef[];
  classes: ClassDef[];
  methods: MethodDef[];
  callSites: CallSite[];
  imports: ImportDecl[];
}

/**
 * Parse a source file and extract all structural info.
 * Dispatches to the appropriate language adapter based on file extension.
 * Returns null if no adapter is registered for this file type.
 */
export function parseFile(filePath: string): ParsedFile | null {
  const ext = extname(filePath);
  const adapter = getAdapterForExtension(ext);
  if (!adapter) return null;

  const content = readFileSync(filePath, "utf-8");
  const tree = adapter.getParser(ext).parse(content);
  return adapter.extractNodes(tree, filePath, content);
}
