/**
 * @brainst0rm/code-graph — tree-sitter knowledge graph for TypeScript codebases.
 *
 * Builds a SQLite graph of functions, classes, methods, and call edges.
 * Answers structural queries like:
 *   - Who calls this function?
 *   - What does this function call?
 *   - What breaks if I change this?
 *   - Go to definition
 *
 * Inspired by Codebase-Memory (arxiv 2603.27277) — the state of the art.
 */

export { parseFile } from "./parser.js";
export type {
  ParsedFile,
  FunctionDef,
  ClassDef,
  MethodDef,
  CallSite,
  ImportDecl,
} from "./parser.js";

export { CodeGraph } from "./graph.js";
export type { GraphOptions } from "./graph.js";

export { indexProject } from "./indexer.js";
export type { IndexProgress } from "./indexer.js";
